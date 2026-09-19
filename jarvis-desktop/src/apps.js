/**
 * Finding the programs already installed on this machine.
 *
 * JARVIS opens applications the way you would: by picking the shortcut Windows
 * already put in the Start menu. It never takes a path or a command line from
 * the model — the model picks a *name*, that name is matched against the list
 * of shortcuts discovered here, and the shortcut is handed to the shell. So the
 * worst a confused or manipulated model can do is start a program you already
 * have, after you have approved that program by name.
 *
 * The scanning is separated from the matching so the matching can be tested
 * without a Windows filesystem.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Where Windows keeps the shortcuts that appear in the Start menu. */
export function startMenuDirs(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return [];
  const roaming = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const common = env.ProgramData || 'C:\\ProgramData';
  return [
    path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(common, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
}

/** A shortcut is only interesting if it actually launches something. */
const LAUNCHABLE = new Set(['.lnk', '.url', '.appref-ms']);

async function walk(dir, depth, out) {
  if (depth < 0) return out;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // Missing or unreadable: not an error, just nothing there.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, depth - 1, out);
    } else if (LAUNCHABLE.has(path.extname(entry.name).toLowerCase())) {
      out.push({ name: path.basename(entry.name, path.extname(entry.name)), path: full });
    }
  }
  return out;
}

/** Every launchable shortcut, de-duplicated by name. */
export async function discover(dirs = startMenuDirs()) {
  const found = [];
  for (const dir of dirs) await walk(dir, 4, found);
  const seen = new Map();
  for (const app of found) {
    const k = app.name.toLowerCase();
    if (!seen.has(k)) seen.set(k, app);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Match what the model asked for against what is installed. Exact first, then
 * prefix, then contains — and nothing at all rather than a wild guess, because
 * the fallback for "no match" is telling the user, not opening something else.
 */
/**
 * How well a name matches, in tiers rather than on a sliding scale. Two apps in
 * the same tier are equally good answers — "Edge" matches "Edge Dev" and "Edge
 * Beta" exactly as well — and the shorter name being shorter is not a reason to
 * prefer it. Keeping that judgement out of the score is what lets `resolve`
 * notice the request was ambiguous instead of quietly picking one.
 */
function tier(name, want) {
  if (name === want) return 4;
  if (name.startsWith(want)) return 3;
  if (name.includes(want)) return 2;
  if (want.includes(name) && name.length > 2) return 1;
  return 0;
}

export function rank(apps, query) {
  const want = fold(query);
  if (!want) return [];
  return apps
    .map((app) => ({ app, score: tier(fold(app.name), want) }))
    .filter((hit) => hit.score > 0)
    // Shortest first within a tier is only a display order, never a decision.
    .sort((a, b) => b.score - a.score || a.app.name.length - b.app.name.length
      || a.app.name.localeCompare(b.app.name));
}

export function match(apps, query) {
  return rank(apps, query).map((s) => s.app);
}

/**
 * Resolve a request to exactly one installed app, or explain why not. The model
 * never gets to supply a path; this is the only way through.
 */
export function resolve(apps, query) {
  const hits = rank(apps, query);
  if (!hits.length) return { ok: false, reason: `Nothing called "${query}" is installed.` };
  // Several equally good answers means the request was ambiguous. Say so
  // rather than picking one: opening the wrong program is worse than asking.
  const best = hits.filter((h) => h.score === hits[0].score);
  if (best.length > 1) {
    const names = best.slice(0, 4).map((h) => h.app.name);
    return { ok: false, reason: `Several match "${query}": ${names.join(', ')}.` };
  }
  return { ok: true, app: hits[0].app };
}
