/**
 * Engine selection logic. recognizer.js reads window.SpeechRecognition at import
 * time, so we stub the DOM globals and use cache-busting query strings to import
 * it once with the browser engine present and once without.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

function stubDom({ webSpeech }) {
  globalThis.window = webSpeech ? { SpeechRecognition: function () {} } : {};
  globalThis.document = { createElement: () => ({}), head: { append() {} } };
}

test('auto prefers the browser engine when available', async () => {
  stubDom({ webSpeech: true });
  const { chooseEngine, webSpeechSupported } = await import('../public/js/recognizer.js?a=1');
  assert.equal(webSpeechSupported(), true);
  assert.equal(chooseEngine('auto'), 'web-speech');
  assert.equal(chooseEngine('web-speech'), 'web-speech');
  assert.equal(chooseEngine('vosk'), 'vosk', 'explicit on-device is always honoured');
});

test('falls back to on-device when the browser engine is missing', async () => {
  stubDom({ webSpeech: false });
  const { chooseEngine, webSpeechSupported } = await import('../public/js/recognizer.js?a=2');
  assert.equal(webSpeechSupported(), false);
  assert.equal(chooseEngine('auto'), 'vosk');
  assert.equal(chooseEngine('web-speech'), 'vosk', 'no browser engine → on-device');
  assert.equal(chooseEngine('vosk'), 'vosk');
});
