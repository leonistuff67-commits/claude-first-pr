/**
 * Where the brain lives on disk. One JSON file, written atomically so a crash
 * mid-write cannot leave a half-file behind and lose everything JARVIS knows.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createState, normalise } from './brain.js';

export function defaultPath() {
  if (process.env.JARVIS_BRAIN) return process.env.JARVIS_BRAIN;
  const home = os.homedir();
  // Follow each platform's convention rather than dropping a dotfile in $HOME.
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(base, 'jarvis', 'brain.json');
}

export class Store {
  constructor(file = defaultPath()) {
    this.file = file;
  }

  async read() {
    try {
      return normalise(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch {
      // Missing or unreadable: start fresh rather than refusing to run.
      return createState();
    }
  }

  async write(state) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this.file);
    return state;
  }

  /** Read, apply, write — the shape every tool here needs. */
  async update(fn) {
    const before = await this.read();
    const result = fn(before);
    await this.write(result.state);
    return result;
  }
}
