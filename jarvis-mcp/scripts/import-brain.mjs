/**
 * Fold a brain exported from the browser app into the desktop one.
 *
 *   npm run import -- ~/Downloads/jarvis-brain.json
 *
 * Importing the same file twice adds nothing the second time, so it is safe to
 * re-run whenever you have taught the web version something new.
 */
import fs from 'node:fs/promises';
import { Store } from '../src/store.js';
import { merge, stats } from '../src/brain.js';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run import -- <path to exported brain json>');
  process.exit(1);
}

const store = new Store();
let incoming;
try {
  incoming = JSON.parse(await fs.readFile(file, 'utf8'));
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}`);
  process.exit(1);
}

const { added } = await store.update((state) => merge(state, incoming));
const now = stats(await store.read());
console.log(`Imported ${added.facts} new fact(s) and ${added.tasks} new task(s).`);
console.log(`JARVIS now knows ${now.facts} fact(s) and has ${now.openTasks} open task(s).`);
console.log(`Brain file: ${store.file}`);
