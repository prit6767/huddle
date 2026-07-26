// Builds the "actionable" half of an option: real, working links.
//
// These are deliberately SEARCH urls scoped to the city rather than deep links
// to a specific listing ID. A search link is always honest — it can't point at
// a business that doesn't exist or a reservation page that has moved. When you
// wire in a real places API, swap these for the provider's canonical URLs.
import { toCalendarStamp, formatDate, formatTime } from './timeutil.mjs';

const enc = encodeURIComponent;

export function buildLinks({ venue, city, slot, partySize, title }) {
  const query = `${venue.name} ${city}`;
  const links = [];

  links.push({
    label: 'Find on Maps',
    kind: 'maps',
    url: `https://www.google.com/maps/search/?api=1&query=${enc(query)}`,
  });

  if (venue.booking === 'opentable') {
    links.push({
      label: 'Reserve on OpenTable',
      kind: 'booking',
      url: `https://www.opentable.com/s?term=${enc(venue.name)}&covers=${partySize}&dateTime=${enc(
        `${slot.date} ${slot.start}`
      )}&metroId=&latitude=&longitude=&size=${partySize}`,
    });
  } else if (venue.booking === 'resy') {
    links.push({
      label: 'Reserve on Resy',
      kind: 'booking',
      url: `https://resy.com/cities?query=${enc(query)}&seats=${partySize}&date=${slot.date}`,
    });
  } else if (venue.booking === 'website') {
    links.push({
      label: 'Book / check hours',
      kind: 'booking',
      url: `https://duckduckgo.com/?q=${enc(`${query} booking tickets`)}`,
    });
  } else {
    links.push({
      label: 'Walk-in — check hours',
      kind: 'info',
      url: `https://duckduckgo.com/?q=${enc(`${query} hours`)}`,
    });
  }

  const start = toCalendarStamp(slot.date, slot.start);
  const end = toCalendarStamp(slot.date, slot.end);
  const details = `${title} — ${venue.name}. Planned with Huddle.`;
  links.push({
    label: 'Add to Calendar',
    kind: 'calendar',
    url:
      `https://calendar.google.com/calendar/render?action=TEMPLATE` +
      `&text=${enc(`${title} @ ${venue.name}`)}` +
      `&dates=${start}/${end}` +
      `&details=${enc(details)}` +
      `&location=${enc(query)}`,
  });

  return links;
}

/** A one-line summary a human can paste straight back into the group chat. */
export function shareLine({ option, city, title }) {
  const when = `${formatDate(option.slot.date)}, ${formatTime(option.slot.start)}`;
  return `${title}: ${option.venue.name} (${city}) — ${when}, about ${option.estimatePerPerson}/person.`;
}
