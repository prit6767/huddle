// Discord adapter (discord.js, gateway connection — no public URL needed).
//
// SETUP:
//   1. https://discord.com/developers/applications -> New Application -> Bot
//   2. Bot -> Privileged Gateway Intents -> enable MESSAGE CONTENT INTENT.
//      Without it Discord delivers empty message bodies and the bot can only
//      see its own mentions — same trap as Telegram's privacy mode.
//   3. OAuth2 -> URL Generator -> scopes: bot
//      permissions: Send Messages, Read Message History, Add Reactions
//   4. Open the generated URL, add the bot to your server
//   5. DISCORD_BOT_TOKEN=... npm run bots
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { handleEvent, handleVote } from './bridge.mjs';

const DISCORD_MAX = 2000;

export function discordConfigured() {
  return Boolean(process.env.DISCORD_BOT_TOKEN);
}

/** Discord hard-caps messages at 2000 chars; split on blank lines, never mid-option. */
function chunk(text, limit = DISCORD_MAX - 50) {
  if (text.length <= limit) return [text];
  const out = [];
  let buffer = '';
  for (const block of text.split('\n\n')) {
    if (buffer && buffer.length + block.length + 2 > limit) {
      out.push(buffer);
      buffer = block;
    } else {
      buffer = buffer ? `${buffer}\n\n${block}` : block;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

function rows(buttons) {
  if (!buttons?.length) return [];
  // Max 5 buttons per row; we only ever emit 3.
  return [
    new ActionRowBuilder().addComponents(
      buttons.slice(0, 5).map((b) =>
        new ButtonBuilder()
          .setCustomId(b.id.slice(0, 100))
          .setLabel(b.label.slice(0, 80))
          .setStyle(ButtonStyle.Secondary)
      )
    ),
  ];
}

async function deliver(message, action) {
  if (!action || action.silent) return;

  if (action.react) {
    try {
      await message.react(action.react);
    } catch (err) {
      console.warn('[discord] reaction failed:', err.message);
    }
    return;
  }

  if (action.text) {
    const pieces = chunk(action.text);
    for (let i = 0; i < pieces.length; i++) {
      const last = i === pieces.length - 1;
      await message.channel.send({
        content: pieces[i],
        components: last ? rows(action.buttons) : [],
        allowedMentions: { parse: [] }, // never let plan text ping @everyone
      });
    }
  }
}

export async function startDiscord() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // required to receive DMs
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content) {
      // Almost always the missing MESSAGE CONTENT INTENT.
      return;
    }
    try {
      const mentioned =
        message.mentions.has(client.user) || !message.guild; /* DMs are always for us */
      const repliedToBot = message.mentions.repliedUser?.id === client.user.id;

      const action = await handleEvent({
        platform: 'discord',
        chatId: message.channelId,
        chatTitle: message.guild?.name || null,
        userId: message.author.id,
        userName: message.member?.displayName || message.author.globalName || message.author.username,
        // Drop the <@id> token so the question reads naturally to the model.
        text: message.content.replace(/<@!?\d+>/g, '').trim() || message.content,
        mentioned,
        repliedToBot,
        typing: () => message.channel.sendTyping().catch(() => {}),
      });
      await deliver(message, action);
    } catch (err) {
      console.error('[discord] message failed:', err.message);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    try {
      const [, , optionId] = interaction.customId.split(':');
      const action = handleVote({
        platform: 'discord',
        chatId: interaction.channelId,
        userId: interaction.user.id,
        userName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
        optionId,
      });
      await interaction.reply({ content: action.text, allowedMentions: { parse: [] } });
    } catch (err) {
      console.error('[discord] interaction failed:', err.message);
    }
  });

  client.once('clientReady', (c) => {
    console.log(`  [discord] connected as ${c.user.tag}`);
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
  return client;
}
