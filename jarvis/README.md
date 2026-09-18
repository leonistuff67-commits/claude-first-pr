# JARVIS

A voice-first AI assistant that runs in the browser. Say the wake word, talk to it,
and it talks back — with a reactive orb, a persistent memory of you, and tools it
can actually run.

![The HUD: clock and system panel on the left, orb in the centre, tasks and memory on the right](docs/hud.png)

## What it does

- **Installs as a real app.** It's a PWA: install it from Chrome/Edge and it gets its
  own dock/taskbar icon and window, no browser chrome, working fully offline — while
  keeping the wake word and dictation that native wrappers can't.
- **Works with no API key.** Out of the box, with no key at all, JARVIS runs on a
  local pattern-matching brain — timers, tasks, memory, the clock, recolouring and
  serious mode all work offline and never touch the network. Paste an Anthropic key in
  settings whenever you want the real model; it upgrades in place.
- **Wake word.** It listens continuously for "jarvis", captures what you say next, and
  sends it once you stop talking. No button, no push-to-talk (though Space works too).
- **Double-clap to talk.** Two claps anywhere in the room start a capture, so you don't
  even need the wake word. Toggle it in settings.
- **Speaks while it thinks.** Replies are streamed from the Messages API and spoken
  sentence-by-sentence as they arrive, so the first words land while the rest is still
  being written.
- **Barge-in.** Talk over it — "stop", "cancel", or the wake word — and it shuts up
  mid-sentence and aborts the request.
- **Pick your model and effort.** Fable 5.1, Opus 5, Sonnet 5 or Haiku 4.5, each at the
  effort level it supports, from the settings panel.
- **Serious mode.** Say *"Jarvis, activate serious mode"* and it jumps to the strongest
  model at maximum effort, turns red, and stays there until you tell it to stand down —
  for the hard, high-stakes questions.
- **Remembers you.** It decides on its own when something about you is worth keeping,
  and those facts are fed back into every later conversation. They live in
  `localStorage`, so they stay on your machine.
- **Runs tools.** Timers, a task board, memory search, recolouring itself, opening
  links, reading local device status, and the clock.
- **The orb reacts.** It's driven by the real microphone level through a WebAudio
  analyser while you speak, and by speech boundaries while it answers. Its colour and
  motion follow the state machine: standby, listening, thinking, speaking, serious.

![Serious mode: the orb and frame turn red, running offline with a local timer and stored facts](docs/serious.png)

## Running it

There are two ways to run it, depending on whether you want a proper installed
app or just a file to open.

### As an installed app (recommended)

JARVIS is a PWA — it installs to your dock/taskbar and opens in its own window,
no browser chrome, and runs fully offline once installed.

```bash
cd jarvis
npm start
# -> http://localhost:8787
```

Open that in Chrome or Edge and click **Install as an app** on the boot screen
(or the install icon in the address bar). It gets its own icon and window and
behaves like any other desktop app — but keeps the wake word and dictation
working, which native wrappers like Electron can't, because those rely on
Chrome's speech engine.

Everything is cached on first load, so after installing it opens even with no
network. Add an API key in settings for the full model, or leave it out and run
on the offline brain.

### The one file

`jarvis.html` is the whole app — HTML, CSS and every module inlined, no server, no
install. Double-click it and hit **Initialize** — that's it. With no key it runs on the
built-in offline brain (timers, tasks, memory, the clock, colours, serious mode). When
you want the full model, open settings and paste an Anthropic API key: it lives in
`localStorage` and goes straight to the API from the browser using
`anthropic-dangerous-direct-browser-access` — fine for something on your own disk, a
bad idea on anything you share.

**Initialize** is also where JARVIS asks for the microphone — through the browser's
normal permission prompt. Allow it for the wake word and double-clap; deny it and
everything else still works.

Rebuild it after changing anything under `public/` with `npm run build`.

One caveat: Chrome only grants `SpeechRecognition` on `https://` or `localhost`, so on
a bare `file://` page the wake word may be refused (it says so if that happens).
Typing works, and replies are still spoken. For the full hands-free thing, serve it:

### The server

```bash
cd jarvis
ANTHROPIC_API_KEY=sk-ant-... npm start
# -> http://localhost:8787
```

Now it's on `localhost`, the wake word works, and the key never reaches the browser —
the server proxies the stream. Click **Initialize** (browsers require a gesture before
granting the microphone and starting speech synthesis), then say
*"Jarvis, set a ten minute timer"*.

### Environment

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables proxy mode. Without it the browser must supply a key. |
| `PORT` | Server port, default `8787`. |
| `ANTHROPIC_BASE_URL` | Point the proxy somewhere other than `api.anthropic.com` (used by the tests). |

## Browser support

The wake word needs the Web Speech API's `SpeechRecognition`, which today means
Chrome or Edge. Everywhere else the app still works — you type instead, and replies
are still spoken via `speechSynthesis`, which is universal. The UI says which mode
you're in on the boot screen.

## How it fits together

| File | Responsibility |
| --- | --- |
| `jarvis.html` | The built single-file app. Generated — edit `public/`, not this. |
| `build.mjs` | Inlines everything into `jarvis.html`. |
| `server.js` | Static host, plus an SSE-streaming proxy so the API key stays server-side. |
| `public/js/app.js` | The turn loop, the HUD, serious mode, and the state machine. |
| `public/js/brain.js` | Messages API client: per-model request shaping (effort, fallbacks) and SSE parsing. |
| `public/js/offline.js` | The no-key brain: turns phrases into tool calls with no network. |
| `public/js/voice.js` | Wake word, silence detection, barge-in, mic sampling, and the speech queue. |
| `public/js/clap.js` | The double-clap detector — a pure state machine, so it's unit-testable. |
| `public/js/tools.js` | Tool schemas and their browser-side handlers. |
| `public/js/memory.js` | `localStorage` state: settings, facts, tasks, conversation. |
| `public/js/orb.js` | The canvas visualizer. |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icons/` | PWA shell: offline cache, install metadata, app icons. |

A turn runs as: utterance → `messages.create` (streamed) → speak the text as it
arrives → if `stop_reason` is `tool_use`, run every tool in the turn, send all the
results back in one user message, and stream again. It gives up after six rounds.

Conversation history is trimmed to the last 40 messages, and the trim always lands on
a clean user turn so a `tool_result` never ends up orphaned at the front of the
request.

Defaults are tuned for conversation rather than depth: Claude Opus 5 at `effort: "low"`,
with a 4096-token cap. Both are in the settings panel — and serious mode flips them to
the strongest model at `max` for one-off hard questions, restoring your choice when it
stands down.

### A note on "full computer access"

Serious mode makes JARVIS *think* harder; it deliberately does **not** give the web page
the ability to run commands on your machine. A browser tab that executes whatever a voice
command — or the model — decides to run is a remote-code-execution hole, so that piece was
left out on purpose. The tools it does have are the safe, browser-scoped ones above.

## Tests

```bash
npm test              # SSE parser + offline interpreter + clap detector (no browser)
npm run test:e2e      # served app: full turn loop in a real browser vs a mock API
npm run test:bundle   # built jarvis.html over file://: model/effort pickers + serious mode
npm run test:offline  # built jarvis.html with NO key: tools run locally, network untouched
npm run test:clap     # feeds a real two-clap WAV through the mic and checks detection
npm run test:pwa      # manifest + service worker, then boots with the server killed
npm run test:all      # everything above in sequence
```

The unit tests have no dependencies. The browser tests need Playwright (`npm install`);
set `PLAYWRIGHT_MODULE` to an absolute path if yours lives somewhere unusual. Together
they cover every transport and the two things that are easy to get wrong:

- `test:e2e` boots the real server against a mock API and checks a tool-calling turn —
  the reply, the timer panel, that the orb is painting, and that memory survives a reload.
- `test:bundle` rebuilds the single file, opens it off disk in direct mode, and checks the
  request headers, the model and effort pickers, and serious-mode escalation to `max`.
- `test:offline` opens the file with no key and proves the whole thing runs on the local
  brain — a timer and a memory command land, and nothing hits the network.
- `test:clap` synthesizes a WAV with two real claps, plays it through Chromium's fake
  microphone, and asserts the app reacts — the actual audio path, not just the math.
- `test:pwa` checks the manifest and that the service worker activates and precaches the
  shell, then **kills the server** and confirms the app still boots — real offline install.
