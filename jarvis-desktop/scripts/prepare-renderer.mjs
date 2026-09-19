/**
 * The desktop app does not have its own copy of JARVIS — it runs the same one
 * that ships to the web, so a fix in either place lands in both. This copies
 * jarvis/public in before packaging, dropping the service worker, which exists
 * to cache a website and has nothing to do here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(path.dirname(ROOT), 'jarvis', 'public');
const TARGET = path.join(ROOT, 'renderer');

await fs.rm(TARGET, { recursive: true, force: true });
await fs.cp(SOURCE, TARGET, { recursive: true });

// A service worker would cache the app against itself inside a packaged shell.
await fs.rm(path.join(TARGET, 'sw.js'), { force: true });
const indexPath = path.join(TARGET, 'index.html');
const index = await fs.readFile(indexPath, 'utf8');
await fs.writeFile(
  indexPath,
  index.replace(/<script[^>]*serviceWorker[\s\S]*?<\/script>/g, ''),
  'utf8',
);

const files = await fs.readdir(path.join(TARGET, 'js'));
console.log(`renderer ready: ${files.length} modules from jarvis/public`);
