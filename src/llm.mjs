// Thin wrapper over the Anthropic SDK.
//
// Everything here degrades gracefully. If no credentials are configured — or
// the API rejects the request for any reason — callers fall back to the
// deterministic logic in extract.mjs / recommend.mjs, so the app runs end to
// end with zero setup.
import Anthropic from '@anthropic-ai/sdk';
import { recordUsage } from './budget.mjs';

// Default to the cheapest capable model. Every call here is short — extracting
// constraints from one chat message, or answering one question — so the
// frontier models are poor value for this workload. Override with HUDDLE_MODEL
// (`claude-opus-5` gives noticeably better answers at roughly 5x the price).
export const MODEL = process.env.HUDDLE_MODEL || 'claude-haiku-4-5';

/**
 * What this model's API surface actually accepts.
 *
 * This matters more than it looks: Haiku 4.5 REJECTS `output_config.effort`
 * with a 400, and only supports the original web-search tool. Sending the
 * frontier-model request shape to a cheap model fails outright, so the shape
 * has to follow the model rather than being hardcoded.
 */
export function traitsFor(model = MODEL) {
  const m = String(model).toLowerCase();
  const preEffort = /haiku-4-5|haiku-3|sonnet-4-5|sonnet-3/.test(m);
  return {
    supportsEffort: !preEffort,
    // Dynamic-filtering search landed with the 4.6 generation; older models
    // only know the original tool.
    searchTool: preEffort ? 'web_search_20250305' : 'web_search_20260209',
  };
}

// Structured outputs are the canonical way to get schema-valid JSON back, but
// the parameter has moved between API vintages (top-level `output_format` ->
// `output_config.format`) and the installed SDK's *types* can lag the deployed
// API. Rather than guess, we try the canonical shape once and remember what
// worked. `prompted` is the floor: ask for JSON in the prompt and parse it.
const MODES = ['output_config', 'output_format', 'prompted'];
let mode = MODES[0];

let client = null;
let clientAttempted = false;

export function getClient() {
  if (clientAttempted) return client;
  clientAttempted = true;
  try {
    // The SDK resolves credentials itself: ANTHROPIC_API_KEY, then
    // ANTHROPIC_AUTH_TOKEN, then an `ant auth login` profile on disk.
    client = new Anthropic();
  } catch (err) {
    console.warn(`[llm] no Anthropic client (${err.message}) — using heuristic fallbacks`);
    client = null;
  }
  return client;
}

export function llmAvailable() {
  if (process.env.HUDDLE_DISABLE_LLM === '1') return false;
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.ANTHROPIC_PROFILE
  );
}

/**
 * System prompts here are static per call-site (the extractor and narrator
 * each reuse one prompt verbatim), so mark them cacheable: repeat calls bill
 * the shared prefix at the cached-input rate instead of full price.
 */
function cacheableSystem(system) {
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

function buildRequest({ system, messages, schema, effort, maxTokens, forMode }) {
  const base = { model: MODEL, max_tokens: maxTokens, messages };
  // Omit effort entirely on models that reject it, rather than eating a 400.
  const effortConfig = traitsFor().supportsEffort ? { effort } : {};

  if (forMode === 'output_config') {
    return {
      ...base,
      system: cacheableSystem(system),
      output_config: { ...effortConfig, format: { type: 'json_schema', schema } },
    };
  }
  if (forMode === 'output_format') {
    return {
      ...base,
      system: cacheableSystem(system),
      ...(traitsFor().supportsEffort ? { output_config: effortConfig } : {}),
      output_format: { type: 'json_schema', schema },
    };
  }
  // Prompted mode: no server-side enforcement, so the schema goes in the prompt
  // and we parse defensively.
  return {
    ...base,
    system: cacheableSystem(
      `${system}\n\nRespond with a single JSON object and nothing else — no prose, no markdown fence. It must validate against this JSON Schema:\n${JSON.stringify(
        schema
      )}`
    ),
  };
}

/** Pull a JSON object out of a response that may be fenced or padded with prose. */
function parseLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * One structured call. Returns the parsed object, or null if it could not be
 * produced — every caller has a deterministic fallback path.
 */
export async function structured({ system, messages, schema, effort = 'low', maxTokens = 4000 }) {
  if (!llmAvailable()) return null;
  const anthropic = getClient();
  if (!anthropic) return null;

  // Start from the mode we already know works; only walk forward on a 400.
  for (let i = MODES.indexOf(mode); i < MODES.length; i++) {
    const forMode = MODES[i];
    try {
      const response = await anthropic.messages.create(
        buildRequest({ system, messages, schema, effort, maxTokens, forMode })
      );

      if (forMode !== mode) {
        console.warn(`[llm] structured-output mode: ${mode} -> ${forMode}`);
        mode = forMode;
      }

      if (response.stop_reason === 'refusal') {
        console.warn('[llm] request refused:', response.stop_details?.category ?? 'unspecified');
        return null;
      }
      if (response.stop_reason === 'max_tokens') {
        console.warn('[llm] response truncated at max_tokens — falling back');
        return null;
      }

      recordUsage({ model: MODEL, usage: response.usage });

      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (!text.trim()) return null;
      return parseLoose(text);
    } catch (err) {
      // A 400 usually means this API vintage doesn't know the parameter shape —
      // step down to the next mode and retry. Anything else is terminal.
      if (err instanceof Anthropic.BadRequestError && i < MODES.length - 1) {
        console.warn(`[llm] "${forMode}" rejected (${err.message}) — trying next mode`);
        continue;
      }
      if (err instanceof Anthropic.RateLimitError) {
        console.warn('[llm] rate limited — falling back to heuristics');
      } else if (err instanceof Anthropic.AuthenticationError) {
        console.warn('[llm] auth failed — check ANTHROPIC_API_KEY');
      } else if (err instanceof Anthropic.APIError) {
        console.warn(`[llm] API error ${err.status}: ${err.message}`);
      } else {
        console.warn('[llm] unexpected failure:', err.message);
      }
      return null;
    }
  }
  return null;
}
