/**
 * Speech recognizers — the source of transcripts, behind one interface so the
 * rest of JARVIS doesn't care how the words arrived.
 *
 * Two engines:
 *   - WebSpeechRecognizer: the browser's built-in SpeechRecognition. Zero setup,
 *     accurate, but Chrome/Edge only and it phones home to Google.
 *   - VoskRecognizer: captures the raw microphone (getUserMedia, like a game's
 *     voice chat) and transcribes it on-device with a WASM model. Works in any
 *     browser and fully offline once the model is cached — no cloud, no key.
 *
 * Both emit the same events:
 *   on.transcript(finalText, interimText)  — words heard
 *   on.status(state)                        — 'loading' | 'listening' | 'off'
 *   on.error(message)
 */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/** A sensible default on-device model (small English). Overridable in settings. */
export const DEFAULT_VOSK_MODEL =
  'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz';

const VOSK_CDN = 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js';

export function webSpeechSupported() {
  return Boolean(SpeechRecognition);
}

/** Load the Vosk UMD bundle once and hand back the global it defines. */
let voskLoading = null;
function loadVosk() {
  if (window.Vosk) return Promise.resolve(window.Vosk);
  if (voskLoading) return voskLoading;
  voskLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = VOSK_CDN;
    s.async = true;
    s.onload = () => (window.Vosk ? resolve(window.Vosk) : reject(new Error('Vosk failed to initialise')));
    s.onerror = () => reject(new Error('Could not load the on-device speech engine.'));
    document.head.append(s);
  });
  return voskLoading;
}

/** The browser's own recognizer. */
export class WebSpeechRecognizer {
  constructor({ getSettings, on }) {
    this.getSettings = getSettings;
    this.on = on;
    this.rec = null;
    this.active = false;
    this.restartDelay = 250;
  }

  get name() {
    return 'web-speech';
  }

  start() {
    if (!SpeechRecognition) {
      this.on.error?.('This browser has no built-in speech recognition.');
      return false;
    }
    this.active = true;
    this.#spinUp();
    return true;
  }

  stop() {
    this.active = false;
    try {
      this.rec?.stop();
    } catch {
      // Already stopped.
    }
    this.on.status?.('off');
  }

  #spinUp() {
    if (!this.active || this.rec) return;
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    rec.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.on.transcript?.(final, interim);
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.active = false;
        this.on.error?.('Microphone permission denied — speech recognition is off.');
      } else if (event.error === 'audio-capture') {
        this.active = false;
        this.on.error?.('No microphone found.');
      }
    };
    rec.onend = () => {
      this.rec = null;
      if (!this.active) {
        this.on.status?.('off');
        return;
      }
      setTimeout(() => this.#spinUp(), this.restartDelay);
    };

    try {
      rec.start();
      this.rec = rec;
      this.on.status?.('listening');
    } catch {
      setTimeout(() => this.#spinUp(), 500);
    }
  }
}

/**
 * On-device recognizer. Captures the shared mic stream, feeds raw PCM to a Vosk
 * WASM model, and streams partial + final transcripts — no cloud, works in any
 * browser.
 */
export class VoskRecognizer {
  constructor({ getSettings, getStream, getAudioContext, on }) {
    this.getSettings = getSettings;
    this.getStream = getStream;
    this.getAudioContext = getAudioContext;
    this.on = on;
    this.active = false;
    this.model = null;
    this.rec = null;
    this.node = null;
    this.source = null;
    this.sink = null;
  }

  get name() {
    return 'vosk';
  }

  async start() {
    if (this.active) return true;
    this.active = true;
    this.on.status?.('loading');
    try {
      const Vosk = await loadVosk();
      if (!this.active) return false; // stopped while loading
      const modelUrl = this.getSettings().voskModelUrl || DEFAULT_VOSK_MODEL;
      this.model = await Vosk.createModel(modelUrl);
      if (!this.active) return false;

      const ctx = this.getAudioContext();
      this.rec = new this.model.KaldiRecognizer(ctx.sampleRate);
      this.rec.on('result', (m) => this.on.transcript?.(m.result?.text || '', ''));
      this.rec.on('partialresult', (m) => this.on.transcript?.('', m.result?.partial || ''));

      // Raw-audio path: mic → script processor → recognizer. A zero-gain sink
      // keeps the graph pulling audio without echoing the mic to the speakers.
      this.source = ctx.createMediaStreamSource(this.getStream());
      this.node = ctx.createScriptProcessor(4096, 1, 1);
      this.node.onaudioprocess = (e) => {
        if (this.active && this.rec) {
          try {
            this.rec.acceptWaveform(e.inputBuffer);
          } catch {
            // Recognizer torn down mid-frame; ignore.
          }
        }
      };
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);

      this.on.status?.('listening');
      return true;
    } catch (err) {
      this.active = false;
      this.on.error?.(err.message || 'On-device speech engine failed to start.');
      return false;
    }
  }

  stop() {
    this.active = false;
    try {
      this.node?.disconnect();
      this.source?.disconnect();
      this.sink?.disconnect();
      this.rec?.remove?.();
    } catch {
      // Best effort.
    }
    this.node = this.source = this.sink = this.rec = null;
    this.on.status?.('off');
  }
}

/**
 * Pick an engine. 'auto' prefers the browser's recognizer when present (it's
 * the most accurate and needs no download), else the on-device one.
 */
export function chooseEngine(preference) {
  if (preference === 'web-speech') return webSpeechSupported() ? 'web-speech' : 'vosk';
  if (preference === 'vosk') return 'vosk';
  return webSpeechSupported() ? 'web-speech' : 'vosk';
}
