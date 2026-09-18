/**
 * Connectors — deep links into apps you already use.
 *
 * A browser page can't read your mailbox without a full Google OAuth setup, so
 * instead of pretending, these hand the work off: JARVIS composes the email,
 * the event, the search or the message and opens it in the real app with
 * everything filled in. You stay in control of the send button.
 *
 * Every builder is a pure function returning a URL, so they're unit-testable
 * and there's no way for a malformed argument to silently open something odd.
 */

/** Format a Date (or ISO string) as the compact UTC stamp Google Calendar wants. */
export function calendarStamp(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) throw new Error('invalid date');
  return `${d.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

const enc = (v) => encodeURIComponent(String(v ?? ''));

/**
 * The registry. Each connector declares the tools it contributes; `build`
 * turns tool input into a URL to open.
 */
export const CONNECTORS = {
  gmail: {
    name: 'Gmail',
    blurb: 'Compose an email with the recipient, subject and body already written.',
    example: '"Jarvis, email sam@example.com about moving Friday’s meeting"',
    tools: [{
      name: 'compose_email',
      description:
        'Open a new email with the fields pre-filled. Use when the user wants to email, '
        + 'write to or message someone. The user still presses send themselves.',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address. Omit if unknown.' },
          subject: { type: 'string', description: 'Subject line.' },
          body: { type: 'string', description: 'The message, written out in full.' },
        },
        required: ['body'],
      },
      build: ({ to = '', subject = '', body = '' }) =>
        `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(to)}&su=${enc(subject)}&body=${enc(body)}`,
      say: ({ to }) => `Drafted the email${to ? ` to ${to}` : ''} — it's open, ready to send.`,
    }],
  },

  calendar: {
    name: 'Google Calendar',
    blurb: 'Create an event with the title, time and details filled in.',
    example: '"Jarvis, put dentist on the calendar for Tuesday at 3pm"',
    tools: [{
      name: 'create_calendar_event',
      description:
        'Open a pre-filled new calendar event. Work out the absolute start time yourself '
        + '(call get_datetime first if the user said something relative like "tomorrow").',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title.' },
          start: { type: 'string', description: 'Start time as an ISO 8601 timestamp.' },
          minutes: { type: 'number', description: 'Length in minutes. Defaults to 60.' },
          details: { type: 'string', description: 'Optional notes.' },
          location: { type: 'string', description: 'Optional location.' },
        },
        required: ['title', 'start'],
      },
      build: ({ title, start, minutes = 60, details = '', location = '' }) => {
        const from = new Date(start);
        const to = new Date(from.getTime() + Number(minutes) * 60000);
        const dates = `${calendarStamp(from)}/${calendarStamp(to)}`;
        return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
          + `&text=${enc(title)}&dates=${dates}&details=${enc(details)}&location=${enc(location)}`;
      },
      say: ({ title }) => `Opened a calendar event for "${title}".`,
    }],
  },

  maps: {
    name: 'Google Maps',
    blurb: 'Pull up directions to somewhere.',
    example: '"Jarvis, directions to the nearest hardware store"',
    tools: [{
      name: 'get_directions',
      description: 'Open directions to a place. Use when the user asks how to get somewhere.',
      input_schema: {
        type: 'object',
        properties: {
          destination: { type: 'string', description: 'Where they are going.' },
          from: { type: 'string', description: 'Starting point. Omit to use current location.' },
          mode: { type: 'string', description: 'driving, walking, bicycling or transit.' },
        },
        required: ['destination'],
      },
      build: ({ destination, from = '', mode = '' }) =>
        `https://www.google.com/maps/dir/?api=1&destination=${enc(destination)}`
        + (from ? `&origin=${enc(from)}` : '')
        + (mode ? `&travelmode=${enc(mode)}` : ''),
      say: ({ destination }) => `Directions to ${destination} are up.`,
    }],
  },

  search: {
    name: 'Web search',
    blurb: 'Look something up on the web.',
    example: '"Jarvis, look up how long to boil an egg"',
    tools: [{
      name: 'search_web',
      description:
        'Open a web search. Use when the user asks you to look something up, or asks about '
        + 'current events you cannot possibly know.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to search for.' } },
        required: ['query'],
      },
      build: ({ query }) => `https://www.google.com/search?q=${enc(query)}`,
      say: ({ query }) => `Searching for ${query}.`,
    }],
  },

  youtube: {
    name: 'YouTube',
    blurb: 'Find music or a video.',
    example: '"Jarvis, play lo-fi beats on YouTube"',
    tools: [{
      name: 'play_video',
      description: 'Open a YouTube search for something to watch or listen to.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to play.' } },
        required: ['query'],
      },
      build: ({ query }) => `https://www.youtube.com/results?search_query=${enc(query)}`,
      say: ({ query }) => `Pulling up ${query}.`,
    }],
  },

  whatsapp: {
    name: 'WhatsApp',
    blurb: 'Start a WhatsApp message with the text written.',
    example: '"Jarvis, WhatsApp mum that I’ll be late"',
    tools: [{
      name: 'send_whatsapp',
      description:
        'Open WhatsApp with a message pre-written. The user picks the contact and presses send.',
      input_schema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The message text.' },
          phone: { type: 'string', description: 'Optional number in international format, digits only.' },
        },
        required: ['message'],
      },
      build: ({ message, phone = '' }) => {
        const digits = String(phone).replace(/\D/g, '');
        return digits
          ? `https://wa.me/${digits}?text=${enc(message)}`
          : `https://wa.me/?text=${enc(message)}`;
      },
      say: () => 'WhatsApp is open with the message ready.',
    }],
  },

  translate: {
    name: 'Google Translate',
    blurb: 'Translate a phrase into another language.',
    example: '"Jarvis, how do I say where is the station in Japanese"',
    tools: [{
      name: 'translate_text',
      description: 'Open a translation of some text into a target language.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to translate.' },
          to: { type: 'string', description: 'Target language code, e.g. ja, fr, es.' },
        },
        required: ['text', 'to'],
      },
      build: ({ text, to }) =>
        `https://translate.google.com/?sl=auto&tl=${enc(to)}&text=${enc(text)}&op=translate`,
      say: ({ to }) => `Translated into ${to}.`,
    }],
  },
};

/** Default on/off state — everything on, since nothing here sends anything by itself. */
export function defaultConnectorSettings() {
  return Object.fromEntries(Object.keys(CONNECTORS).map((id) => [id, true]));
}

/** Tool definitions (Anthropic shape) for the enabled connectors. */
export function connectorTools(enabled = {}) {
  const out = [];
  for (const [id, connector] of Object.entries(CONNECTORS)) {
    if (enabled[id] === false) continue;
    for (const tool of connector.tools) {
      const { build, say, ...definition } = tool;
      out.push(definition);
    }
  }
  return out;
}

/** Find the tool implementation behind a name, respecting the enabled set. */
export function findConnectorTool(name, enabled = {}) {
  for (const [id, connector] of Object.entries(CONNECTORS)) {
    if (enabled[id] === false) continue;
    const tool = connector.tools.find((t) => t.name === name);
    if (tool) return { connectorId: id, connector, tool };
  }
  return null;
}
