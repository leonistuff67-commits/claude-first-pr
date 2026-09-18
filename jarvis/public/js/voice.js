/**
 * Ears and mouth.
 *
 * Ears: continuous Web Speech recognition that idles on a wake word, then
 * captures an utterance and commits it after a beat of silence.
 * Mouth: speechSynthesis fed sentence-by-sentence so JARVIS starts talking
 * while the model is still writing.
 *
 * Also owns the mic analyser, which gives the orb something real to react to.
 *
 * Transcription itself is delegated to a recognizer engine (recognizer.js) —
 * the browser's built-in one, or an on-device WASM recognizer fed the raw mic
 * so dictation works in any browser. This class turns whatever they hear into
 * wake-word detection, capture and commit.
 */
import { ClapDetector } from './clap.js';
import { WebSpeechRecognizer, VoskRecognizer, chooseEngine, webSpeechSupported } from './recognizer.js';

/** Words that interrupt JARVIS mid-sentence. */
const BARGE_IN = ['stop', 'shut up', 'quiet', 'cancel', 'nevermind', 'never mind'];

/** Voices that sound least like a 2003 GPS, in rough order of preference. */
const VOICE_PREFERENCES = [
  'Google UK English Male', 'Daniel', 'Google US English', 'Samantha',
  'Alex', 'Microsoft Guy', 'Microsoft Ryan',
];

const SILENCE_MS = 1200;

export class Voice {
  constructor({ getSettings, on = {} }) {
    this.getSettings = getSettings;
    this.on = on;
    this.mode = 'off';          // off | idle | capturing
    this.wantsRecognition = false;
    this.suppressed = false;    // true while JARVIS is talking (echo guard)
    this.captured = '';
    this.silenceTimer = null;
    this.speaking = false;
    this.ttsBuffer = '';
    this.analyser = null;
    this.micData = null;
    this.micStream = null;
    this.speechEnvelope = 0;

    this.recognizer = null;
    this.engineName = null;

    // Clap detection runs off a fast time-domain read of the mic, fed into a
    // tested state machine (clap.js).
    this.timeData = null;
    this.clapWatch = null;
    this.clapDetector = new ClapDetector({
      onDouble: () => {
        if (!this.suppressed && !this.speaking) this.on.doubleClap?.();
      },
    });
  }

  /** Any engine can transcribe, so recognition is available unless nothing works. */
  static get supported() {
    return true;
  }

  static get webSpeechSupported() {
    return webSpeechSupported();
  }

  // --- microphone ----------------------------------------------------------

  /** Ask for the mic and wire up an analyser. Safe to call more than once. */
  async enableMic() {
    if (this.analyser) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.micStream = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      // A larger window (~46ms at 44.1kHz) so a clap's transient can't slip
      // between samples, and no smoothing on the time-domain read.
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      this.audioContext = ctx;
      this.analyser = analyser;
      this.micData = new Uint8Array(analyser.frequencyBinCount);
      this.timeData = new Uint8Array(analyser.fftSize);
      // Some browsers start the context suspended until a gesture resumes it.
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return true;
    } catch (err) {
      this.on.error?.(`Microphone unavailable: ${err.message}`);
      return false;
    }
  }

  /**
   * Start sampling the mic for claps and firing `on.doubleClap`. The detection
   * logic lives in the tested ClapDetector; here we just feed it the peak level
   * every frame. Polls fast (~16ms) so a clap's short transient is never missed.
   */
  startClapWatch() {
    if (this.clapWatch || !this.analyser) return;
    this.clapDetector.reset();
    this.clapWatch = setInterval(() => {
      if (!this.analyser) return;
      // While JARVIS talks the mic mostly hears JARVIS — feed silence so its
      // own speech can't clap at it (the detector's floor stays calm too).
      const level = this.suppressed || this.speaking ? 0 : this.#micPeak();
      this.clapDetector.feed(level, performance.now());
    }, 16);
  }

  stopClapWatch() {
    clearInterval(this.clapWatch);
    this.clapWatch = null;
  }

  /** Peak deviation from the midpoint across the current window, 0..1. */
  #micPeak() {
    this.analyser.getByteTimeDomainData(this.timeData);
    let peak = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const dev = Math.abs(this.timeData[i] - 128) / 128;
      if (dev > peak) peak = dev;
    }
    return peak;
  }

  /**
   * The current frequency spectrum as bytes (0..255), for the waveform display.
   * While JARVIS is speaking the mic mostly hears itself, so synthesize a lively
   * spectrum from the speech envelope instead so the bars still dance.
   */
  spectrum(out) {
    const n = out.length;
    if (this.speaking) {
      const e = this.speechEnvelope;
      for (let i = 0; i < n; i++) {
        const shape = Math.sin((i / n) * Math.PI); // fuller in the middle
        out[i] = Math.min(255, e * 255 * shape * (0.6 + Math.random() * 0.7));
      }
      return out;
    }
    if (!this.analyser) {
      out.fill(0);
      return out;
    }
    this.analyser.getByteFrequencyData(this.micData);
    // Resample the analyser bins down to however many bars we're drawing.
    const step = this.micData.length / n;
    for (let i = 0; i < n; i++) out[i] = this.micData[Math.floor(i * step)];
    return out;
  }

  /** Current input loudness, 0..1. Falls back to the speech envelope while talking. */
  level() {
    if (this.speaking) return this.speechEnvelope;
    if (!this.analyser) return 0;
    this.analyser.getByteFrequencyData(this.micData);
    let sum = 0;
    for (let i = 0; i < this.micData.length; i++) sum += this.micData[i];
    const avg = sum / this.micData.length / 255;
    return Math.min(1, avg * 2.6);
  }

  // --- recognition ---------------------------------------------------------

  /** Build the recognizer for whichever engine settings ask for. */
  #buildRecognizer() {
    const want = chooseEngine(this.getSettings().speechEngine || 'auto');
    if (this.recognizer && this.engineName === want) return this.recognizer;

    this.recognizer?.stop();
    this.engineName = want;

    const shared = {
      getSettings: this.getSettings,
      on: {
        transcript: (final, interim) => this.#onTranscript(final, interim),
        status: (state) => {
          if (state === 'loading') this.on.engine?.('loading', want);
          else if (state === 'listening') {
            this.on.engine?.('listening', want);
            if (this.mode === 'off') this.#enterIdle();
          } else if (state === 'off') {
            this.on.mode?.('off');
          }
        },
        error: (msg) => this.on.error?.(msg),
      },
    };

    this.recognizer = want === 'vosk'
      ? new VoskRecognizer({
          ...shared,
          getStream: () => this.micStream,
          getAudioContext: () => this.audioContext,
        })
      : new WebSpeechRecognizer(shared);
    return this.recognizer;
  }

  start() {
    this.wantsRecognition = true;
    this.#buildRecognizer().start();
    return true;
  }

  stop() {
    this.wantsRecognition = false;
    this.mode = 'off';
    this.recognizer?.stop();
    this.on.mode?.('off');
  }

  /** Switch engines at runtime (settings change). */
  reloadEngine() {
    if (!this.wantsRecognition) return;
    this.recognizer?.stop();
    this.recognizer = null;
    this.engineName = null;
    this.#buildRecognizer().start();
  }

  /** Skip the wake word and start capturing immediately (button / spacebar). */
  listenNow() {
    if (!this.wantsRecognition) this.start();
    this.cancelSpeech();
    this.#enterCapture('');
  }

  #enterIdle() {
    this.mode = 'idle';
    this.captured = '';
    clearTimeout(this.silenceTimer);
    this.on.mode?.('idle');
  }

  #enterCapture(seed) {
    this.mode = 'capturing';
    this.captured = seed;
    this.on.mode?.('capturing');
    this.on.wake?.();
    this.#armSilence();
  }

  #armSilence() {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      const text = this.captured.trim();
      this.#enterIdle();
      if (text) this.on.command?.(text);
    }, SILENCE_MS);
  }

  /** Normalized transcript from any engine: freshly-final and interim text. */
  #onTranscript(final, interim) {
    const heard = `${final} ${interim}`.trim();
    if (!heard) return;

    // While JARVIS is talking the mic mostly hears JARVIS. Only act on an
    // explicit interruption.
    if (this.suppressed) {
      const lower = heard.toLowerCase();
      const wake = (this.getSettings().wakeWord || 'jarvis').toLowerCase();
      if (BARGE_IN.some((w) => lower.includes(w)) || lower.includes(wake)) {
        this.cancelSpeech();
        this.on.bargeIn?.();
        if (lower.includes(wake)) this.#enterCapture(this.#afterWake(heard, wake));
      }
      return;
    }

    if (this.mode === 'idle') {
      const wake = (this.getSettings().wakeWord || 'jarvis').toLowerCase();
      const lower = heard.toLowerCase();
      const at = lower.lastIndexOf(wake);
      if (at === -1) {
        this.on.hearing?.(heard, false);
        return;
      }
      this.#enterCapture(this.#afterWake(heard, wake));
      this.on.hearing?.(this.captured, true);
      return;
    }

    if (this.mode === 'capturing') {
      this.captured = final ? `${this.captured} ${final}`.trim() : this.captured;
      this.on.hearing?.(`${this.captured} ${interim}`.trim(), true);
      this.#armSilence();
    }
  }

  #afterWake(heard, wake) {
    const at = heard.toLowerCase().lastIndexOf(wake);
    return heard.slice(at + wake.length).replace(/^[\s,.:;!?-]+/, '');
  }

  // --- speech synthesis ----------------------------------------------------

  /** Feed streaming text; complete sentences are spoken as soon as they land. */
  feed(delta) {
    this.ttsBuffer += delta;
    const cut = this.#lastSentenceBreak(this.ttsBuffer);
    if (cut > 0) {
      const chunk = this.ttsBuffer.slice(0, cut);
      this.ttsBuffer = this.ttsBuffer.slice(cut);
      this.#enqueue(chunk);
    }
  }

  /** Speak whatever is left in the buffer. */
  flush() {
    const rest = this.ttsBuffer.trim();
    this.ttsBuffer = '';
    if (rest) this.#enqueue(rest);
  }

  /** Speak a one-off line (timers firing, errors, greetings). */
  say(text) {
    this.#enqueue(text);
  }

  cancelSpeech() {
    this.ttsBuffer = '';
    window.speechSynthesis?.cancel();
    this.speaking = false;
    this.suppressed = false;
    this.speechEnvelope = 0;
    this.on.speaking?.(false);
  }

  #lastSentenceBreak(text) {
    // Break after . ! ? … or a newline, as long as something follows it.
    const match = /[.!?…\n](?=\s|$)/g;
    let last = -1;
    let m;
    while ((m = match.exec(text)) !== null) last = m.index;
    return last === -1 ? -1 : last + 1;
  }

  #pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    const wanted = this.getSettings().voiceURI;
    if (wanted) {
      const exact = voices.find((v) => v.voiceURI === wanted);
      if (exact) return exact;
    }
    for (const name of VOICE_PREFERENCES) {
      const hit = voices.find((v) => v.name.includes(name));
      if (hit) return hit;
    }
    return voices.find((v) => v.lang?.startsWith('en')) || voices[0];
  }

  #enqueue(text) {
    const clean = text.replace(/[*_`#]/g, '').trim();
    if (!clean || !window.speechSynthesis) return;
    if (!this.getSettings().speak) return;

    const utter = new SpeechSynthesisUtterance(clean);
    const voice = this.#pickVoice();
    if (voice) utter.voice = voice;
    utter.rate = this.getSettings().rate ?? 1.05;
    utter.pitch = this.getSettings().pitch ?? 0.9;

    utter.onstart = () => {
      this.speaking = true;
      this.suppressed = true;
      this.on.speaking?.(true);
    };
    // Drive a fake amplitude envelope off word boundaries so the orb moves
    // with the speech — speechSynthesis output isn't routed through WebAudio.
    utter.onboundary = () => {
      this.speechEnvelope = 0.55 + Math.random() * 0.45;
      setTimeout(() => {
        this.speechEnvelope *= 0.5;
      }, 90);
    };
    const finish = () => {
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) return;
      this.speaking = false;
      this.speechEnvelope = 0;
      this.on.speaking?.(false);
      // Give the mic a moment to stop hearing the tail of the sentence.
      setTimeout(() => {
        this.suppressed = false;
      }, 400);
    };
    utter.onend = finish;
    utter.onerror = finish;

    window.speechSynthesis.speak(utter);
  }
}
