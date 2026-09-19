/**
 * Bundle the app into a single self-contained jarvis.html that runs straight
 * off the filesystem — no server, no build tooling, no network except the API.
 *
 * ES modules can't be imported over file://, so the modules are concatenated in
 * dependency order into one classic script inside an IIFE, with their
 * import/export lines stripped.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

/** Dependency order: each module may use everything above it. */
const MODULES = ['memory.js', 'connectors.js', 'tools.js', 'brain.js', 'offline.js', 'clap.js', 'recognizer.js', 'voice.js', 'orb.js', 'wave.js', 'mind.js', 'providers.js', 'localbrain.js', 'app.js'];

function stripModuleSyntax(source, name) {
  // Drop anything the standalone file can't use (e.g. service-worker
  // registration — there's no SW next to a single file).
  const withoutBuildBlocks = source.replace(
    /^[ \t]*\/\/ BUILD-STRIP-START[\s\S]*?\/\/ BUILD-STRIP-END[ \t]*\n/gm,
    '',
  );
  return withoutBuildBlocks
    .split('\n')
    .filter((line) => !/^import\s.*from\s.*;$/.test(line.trim()))
    .filter((line) => !/^export\s*\{[^}]*\}\s*;$/.test(line.trim()))
    .map((line) => line.replace(/^export\s+(class|function|const|let|async)\s/, '$1 '))
    .join('\n')
    .trim()
    .concat(`\n// --- end ${name} ---\n`);
}

const css = await fs.readFile(path.join(PUBLIC, 'css', 'style.css'), 'utf8');

const scripts = [];
for (const name of MODULES) {
  const source = await fs.readFile(path.join(PUBLIC, 'js', name), 'utf8');
  scripts.push(`// --- ${name} ---\n${stripModuleSyntax(source, name)}`);
}

let html = await fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8');

// A single file can't be a PWA (no service worker over file://), so drop the
// manifest and touch-icon links from the standalone build.
html = html
  .replace(/^\s*<link rel="manifest"[^>]*>\n/m, '')
  .replace(/^\s*<link rel="apple-touch-icon"[^>]*>\n/m, '');

html = html.replace(
  '<link rel="stylesheet" href="css/style.css" />',
  `<style>\n${css}\n</style>`,
);
html = html.replace(
  '<script type="module" src="js/app.js"></script>',
  `<script>\n(function () {\n'use strict';\n\n${scripts.join('\n')}\n}());\n</script>`,
);

// Guard against a module or PWA reference slipping through into the bundle.
for (const marker of ['from \'./', 'type="module"', 'href="css/', 'rel="manifest"', 'serviceWorker']) {
  if (html.includes(marker)) throw new Error(`bundle still references ${marker}`);
}

const out = path.join(ROOT, 'jarvis.html');
await fs.writeFile(out, html);
const { size } = await fs.stat(out);
console.log(`wrote ${path.relative(process.cwd(), out)} (${Math.round(size / 1024)} KB)`);
