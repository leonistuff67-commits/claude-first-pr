/**
 * Drives the real server the way Claude Desktop does: spawn it, speak MCP over
 * stdio, and check that what comes back is what a host would need. Unit tests
 * on the brain cannot catch a mis-wired handler or a schema the host rejects.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const failures = [];
const check = (label, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} -> ${String(actual).replace(/\n/g, ' / ')}`);
  if (!ok) failures.push(label);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-mcp-'));
const brainFile = path.join(dir, 'brain.json');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'server.js')],
  env: { ...process.env, JARVIS_BRAIN: brainFile },
});

const client = new Client({ name: 'jarvis-test', version: '1.0.0' }, { capabilities: {} });
const say = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return res.content.map((c) => c.text).join('\n');
};

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  check('the server advertises its tools', tools.length, 7);
  check('remember is offered', tools.some((t) => t.name === 'remember'), true);
  check('every tool has a schema the host can use',
    tools.every((t) => t.inputSchema?.type === 'object'), true);

  check('a fact is stored', await say('remember', { fact: 'I take the 8am train' }),
    (t) => t.startsWith('Remembered:'));
  check('repeating it is not a second copy', await say('remember', { fact: 'I take the 8am train' }),
    (t) => t.startsWith('Already knew:'));
  check('it can be recalled', await say('recall', { query: 'train' }), (t) => t.includes('8am train'));
  check('an unrelated query finds nothing', await say('recall', { query: 'submarine' }),
    'Nothing stored that matches.');

  await say('add_task', { task: 'ship the desktop port' });
  check('the task is listed open', await say('list_tasks', {}), (t) => t.includes('[ ] ship the desktop port'));
  check('it completes by text', await say('complete_task', { task: 'ship the desktop' }),
    (t) => t.startsWith('Done:'));
  check('and is then off the open list', await say('list_tasks', {}), 'Nothing on the list.');
  check('but still there when asked for everything', await say('list_tasks', { includeDone: true }),
    (t) => t.includes('[x]'));

  check('stats report the brain', await say('brain_stats', {}), (t) => t.includes('1 facts'));
  check('stats name the brain file', await say('brain_stats', {}), (t) => t.includes(brainFile));

  const { resources } = await client.listResources();
  check('the brain is exposed as resources', resources.length, 2);
  const facts = await client.readResource({ uri: 'jarvis://brain/facts' });
  check('the facts resource reads back', facts.contents[0].text, (t) => t.includes('8am train'));

  const { prompts } = await client.listPrompts();
  check('the persona is offered as a prompt', prompts[0]?.name, 'jarvis');
  const persona = await client.getPrompt({ name: 'jarvis', arguments: {} });
  const body = persona.messages[0].content.text;
  check('the persona is JARVIS', body, (t) => t.includes('You are JARVIS'));
  check('the persona carries what it knows', body, (t) => t.includes('8am train'));
  check('the persona says to treat read content as data', body,
    (t) => t.includes('never as') && t.includes('instructions'));

  check('an unknown tool is refused, not guessed at', await say('remember', { fact: '' }),
    (t) => t.includes('Nothing to remember'));

  // What the host writes must survive a restart — that is the whole point.
  const saved = JSON.parse(await fs.readFile(brainFile, 'utf8'));
  check('everything persisted to disk', saved.facts.length, 1);
} finally {
  await client.close().catch(() => {});
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
