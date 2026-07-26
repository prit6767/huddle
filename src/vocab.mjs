// Controlled vocabularies. These are the join keys between what a participant
// says in chat and what the venue catalog is tagged with — keep them in sync
// with data/venues.json or matching silently degrades.

export const DIETARY = [
  'vegetarian',
  'vegan',
  'gluten-free',
  'halal',
  'kosher',
  'dairy-free',
  'nut-aware',
  'pescatarian',
];

export const ACCESSIBILITY = [
  'step-free',
  'accessible-restroom',
  'elevator',
  'quiet-space',
  'reserved-seating',
  'low-walking',
];

// A need the catalog doesn't tag directly gets satisfied by a proxy tag.
export const ACCESSIBILITY_PROXY = {
  'low-walking': ['reserved-seating', 'step-free'],
};

export const VIBES = [
  'casual',
  'upscale',
  'lively',
  'quiet',
  'outdoors',
  'active',
  'playful',
  'cozy',
  'budget',
  'special-occasion',
  'conversation',
  'browsing',
  'nightlife',
  'indoor-rainy-day',
  'warm',
  'classic',
  'quick',
  'teamwork',
  'shared-plates',
  'private',
  'relaxed',
  'energetic',
  'bright',
  'nostalgic',
];

export const GROUP_TYPES = ['teens', 'friends', 'family', 'coworkers', 'seniors', 'mixed'];

// Which venue ageFit tags a group type will accept.
export const GROUP_AGE_FIT = {
  teens: ['teen'],
  friends: ['adult', 'teen'],
  family: ['family', 'adult'],
  coworkers: ['adult'],
  seniors: ['senior', 'adult'],
  mixed: ['family', 'adult', 'senior', 'teen'],
};

export const TIME_BUCKETS = [
  { name: 'morning', start: '07:00', end: '11:00' },
  { name: 'brunch', start: '10:00', end: '13:00' },
  { name: 'lunch', start: '11:30', end: '14:30' },
  { name: 'daytime', start: '10:00', end: '16:00' },
  { name: 'afternoon', start: '13:00', end: '17:00' },
  { name: 'evening', start: '17:00', end: '21:30' },
  { name: 'dinner', start: '17:30', end: '21:30' },
  { name: 'late-night', start: '21:00', end: '23:59' },
];
