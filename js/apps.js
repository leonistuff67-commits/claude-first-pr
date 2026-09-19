/**
 * Opening real apps.
 *
 * On a phone, the right URL doesn't open a website — it opens the installed
 * app, with whatever text we put in it already filled in. That is how JARVIS
 * "opens apps and types stuff" without any device control: no accessibility
 * service, no screen reading, no permissions. The app opens focused on exactly
 * what you asked for, and you take it from there.
 *
 * Each app knows two URLs: the scheme that launches the native app, and a web
 * address for when there's no app (desktop). Builders are pure so every link
 * is tested rather than discovered by tapping a dead button.
 */
const esc = (v) => encodeURIComponent(String(v ?? ""));

/**
 * `native` is tried on phones, `web` everywhere else.
 * `takesText` means the app accepts pre-filled content, not just a search.
 */
export const APPS = {
  spotify: {
    name: 'Spotify',
    blurb: 'Search or play music in the Spotify app.',
    example: '"Jarvis, play Radiohead on Spotify"',
    takesText: false,
    native: ({ query = '' }) => `spotify:search:${esc(query)}`,
    web: ({ query = '' }) => `https://open.spotify.com/search/${esc(query)}`,
  },
  youtube: {
    name: 'YouTube',
    blurb: 'Search YouTube. Opens the app on a phone.',
    example: '"Jarvis, open lo-fi beats on YouTube"',
    takesText: false,
    native: ({ query = '' }) => `https://www.youtube.com/results?search_query=${esc(query)}`,
    web: ({ query = '' }) => `https://www.youtube.com/results?search_query=${esc(query)}`,
  },
  maps: {
    name: 'Maps',
    blurb: 'Open Maps at a place or with directions running.',
    example: '"Jarvis, navigate to the station"',
    takesText: false,
    native: ({ query = '' }) => `geo:0,0?q=${esc(query)}`,
    web: ({ query = '' }) => `https://www.google.com/maps/search/?api=1&query=${esc(query)}`,
  },
  whatsapp: {
    name: 'WhatsApp',
    blurb: 'Open WhatsApp with the message already typed.',
    example: '"Jarvis, WhatsApp mum that I’m on my way"',
    takesText: true,
    native: ({ text = '', phone = '' }) => {
      const digits = String(phone).replace(/\D/g, '');
      return digits ? `whatsapp://send?phone=${digits}&text=${esc(text)}` : `whatsapp://send?text=${esc(text)}`;
    },
    web: ({ text = '', phone = '' }) => {
      const digits = String(phone).replace(/\D/g, '');
      return digits ? `https://wa.me/${digits}?text=${esc(text)}` : `https://wa.me/?text=${esc(text)}`;
    },
  },
  sms: {
    name: 'Messages (SMS)',
    blurb: 'Open a text message with the body written.',
    example: '"Jarvis, text Dan that I’ll be ten minutes late"',
    takesText: true,
    native: ({ text = '', phone = '' }) => {
      const digits = String(phone).replace(/[^\d+]/g, '');
      return `sms:${digits}?body=${esc(text)}`;
    },
    web: ({ text = '', phone = '' }) => `sms:${String(phone).replace(/[^\d+]/g, '')}?body=${esc(text)}`,
  },
  phone: {
    name: 'Phone',
    blurb: 'Bring up the dialler with a number ready. It never dials by itself.',
    example: '"Jarvis, call the dentist"',
    takesText: false,
    native: ({ phone = '' }) => `tel:${String(phone).replace(/[^\d+]/g, '')}`,
    web: ({ phone = '' }) => `tel:${String(phone).replace(/[^\d+]/g, '')}`,
  },
  telegram: {
    name: 'Telegram',
    blurb: 'Open Telegram, optionally sharing some text.',
    example: '"Jarvis, open Telegram"',
    takesText: true,
    native: ({ text = '' }) => (text ? `tg://msg?text=${esc(text)}` : 'tg://resolve'),
    web: ({ text = '' }) => `https://t.me/share/url?url=&text=${esc(text)}`,
  },
  gmail: {
    name: 'Gmail',
    blurb: 'Open Gmail composing a message.',
    example: '"Jarvis, email Sam about Friday"',
    takesText: true,
    native: ({ text = '', subject = '', to = '' }) =>
      `mailto:${esc(to)}?subject=${esc(subject)}&body=${esc(text)}`,
    web: ({ text = '', subject = '', to = '' }) =>
      `https://mail.google.com/mail/?view=cm&fs=1&to=${esc(to)}&su=${esc(subject)}&body=${esc(text)}`,
  },
  calendar: {
    name: 'Calendar',
    blurb: 'Open the calendar.',
    example: '"Jarvis, open my calendar"',
    takesText: false,
    native: () => 'https://calendar.google.com/calendar/r',
    web: () => 'https://calendar.google.com/calendar/r',
  },
  instagram: {
    name: 'Instagram',
    blurb: 'Open Instagram.',
    example: '"Jarvis, open Instagram"',
    takesText: false,
    native: () => 'instagram://app',
    web: () => 'https://www.instagram.com/',
  },
  notes: {
    name: 'Notes / Keep',
    blurb: 'Jot something into Google Keep.',
    example: '"Jarvis, note down the wifi password is hunter2"',
    takesText: true,
    native: ({ text = '' }) => `https://keep.google.com/#NOTE/new?text=${esc(text)}`,
    web: ({ text = '' }) => `https://keep.google.com/#NOTE/new?text=${esc(text)}`,
  },
};

/** Rough phone check — decides native scheme vs web address. */
export function isMobile(userAgent = '') {
  return /android|iphone|ipad|ipod/i.test(String(userAgent));
}

/**
 * Build the URL that opens an app.
 * @returns {{url: string, fallback: string, app: object}}
 */
export function buildAppUrl(appId, params = {}, userAgent = '') {
  const app = APPS[String(appId || '').toLowerCase()];
  if (!app) throw new Error(`I don't know an app called "${appId}".`);
  const web = app.web(params);
  const url = isMobile(userAgent) ? app.native(params) : web;
  return { url, fallback: web, app };
}

/** The tool definition offered to whichever brain is driving. */
export function appTool() {
  return {
    name: 'open_app',
    description:
      'Open an app on the user\'s device, with text already filled in where the app supports it. '
      + `Known apps: ${Object.keys(APPS).join(', ')}. `
      + 'Use this when the user says to open, play, text, call or message something. '
      + 'The app opens ready to go — the user still presses send or play themselves.',
    input_schema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: `Which app: ${Object.keys(APPS).join(', ')}.` },
        query: { type: 'string', description: 'What to search for, where the app searches.' },
        text: { type: 'string', description: 'Message or note body, where the app accepts one.' },
        subject: { type: 'string', description: 'Subject line, for email.' },
        to: { type: 'string', description: 'Email recipient.' },
        phone: { type: 'string', description: 'Phone number, for calls and messages.' },
      },
      required: ['app'],
    },
  };
}

/** A short spoken confirmation. */
export function describeOpen(appId, params = {}) {
  const app = APPS[String(appId || '').toLowerCase()];
  if (!app) return `I don't know that app.`;
  if (params.text) return `${app.name} is open with the message ready.`;
  if (params.query) return `Opening ${params.query} in ${app.name}.`;
  if (params.phone) return `${app.name} is up with the number ready — press call yourself.`;
  return `Opening ${app.name}.`;
}
