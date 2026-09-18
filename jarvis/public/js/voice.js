/**
 * Ears and mouth.
 *
 * Ears: continuous Web Speech recognition that idles on a wake word, then
 * captures an utterance and commits it after a beat of silence.
 * Mouth: speechSynthesis fed sentence-by-sentence so JARVIS starts talking
 * while the model is still writing.
 *
 * Also owns the mic analyser, which gives the orb something real to react to.
 */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/** Words that interrupt JARVIS mid-sentence. */
const BARGE_IN = ['stop', 'shut up', 'quiet', 'cancel', 'nevermind', 'never mind'];

/** Voices that sound least like a 2003 GPS, in rough order of preference. */
const VOICE_PREFERENCES = [
  'Google UK English Male', 'Daniel', 'Google US English', 'Samantha',
  'Alex', 'Microsoft Guy', 'Microsoft Ryan',
];

const SILENCE_MS = 1200;

export class Voice {
  static get supported() {
    return Boolean(SpeechRecognition);
  }

  constructor({ getSettings, on = {} }) {
    this.getSettings = getSettings;
    this.on = on;
    this.mode = 'off';          // off | idle | capturing
    this.recognition = null;
    this.wantsRecognition = false;
    this.suppressed = false;    // true while JARVIS is talking (echo guard)
    this.captured = '';
    this.silenceTimer = null;
    this.speaking = false;
    this.ttsBuffer = '';
    this.analyser = null;
    this.micData = null;
    this.speechEnvelope = 0;
    this.restartDelay = 250;
  }

  // --- microphone ----------------------------------------------------------

  /** Ask for the mic and wire up an analyser. Safe to call more than once. */
  async enableMic() {
    if (this.analyser) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      this.audioContext = ctx;
      this.analyser = analyser;
      this.micData = new Uint8Array(analyser.frequencyBinCount);
      return true;
    } catch (err) {
      this.on.error?.(`Microphone unavailable: ${err.message}`);
      return false;
    }
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

  start() {
    if (!SpeechRecognition) {
      this.on.error?.('This browser has no speech recognition. Use the text box instead.');
      return false;
    }
    this.wantsRecognition = true;
    this.#spinUp();
    return true;
  }

  stop() {
    this.wantsRecognition = false;
    this.mode = 'off';
    try {
      this.recognition?.stop();
    } catch {
      // Already stopped.
    }
    this.on.mode?.('off');
  }

  /** Skip the wake word and start capturing immediately (button / spacebar). */
  listenNow() {
    if (!this.wantsRecognition) this.start();
    this.cancelSpeech();
    this.#enterCapture('');
  }

  #spinUp() {
    if (!this.wantsRecognition || this.recognition) return;
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    rec.onresult = (event) => this.#onResult(event);
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.wantsRecognition = false;
        this.on.error?.('Microphone permission denied — speech recognition is off.');
      } else if (event.error === 'audio-capture') {
        this.wantsRecognition = false;
        this.on.error?.('No microphone found.');
      }
      // 'no-speech' and 'network' are routine; onend handles the restart.
    };
    rec.onend = () => {
      this.recognition = null;
      if (!this.wantsRecognition) {
        this.on.mode?.('off');
        return;
      }
      // Chrome ends the session every so often; bring it straight back.
      setTimeout(() => this.#spinUp(), this.restartDelay);
    };

    try {
      rec.start();
      this.recognition = rec;
      if (this.mode === 'off') this.#enterIdle();
    } catch {
      // start() throws if a session is somehow still alive; the retry covers it.
      setTimeout(() => this.#spinUp(), 500);
    }
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

  #onResult(event) {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) final += result[0].transcript;
      else interim += result[0].transcript;
    }
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
