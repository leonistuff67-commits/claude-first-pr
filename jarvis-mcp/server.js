#!/usr/bin/env node
/**
 * JARVIS as an MCP server.
 *
 * This is JARVIS's brain — the memory, the tasks, the persona — packaged so it
 * can run inside a host that already has computer control, rather than trying
 * to grow control of its own. Claude Desktop is the intended host: point it at
 * this server and JARVIS remembers you there, alongside whatever other servers
 * you have given it.
 *
 * It deliberately does not touch your machine. No shell, no file access beyond
 * its own brain file, no input synthesis. Those belong to servers built for
 * them, where the host's own permission prompts apply.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Store } from './src/store.js';
import * as brain from './src/brain.js';
import { PERSONA } from './src/persona.js';

const store = new Store();

const TOOLS = [
  {
    name: 'remember',
    description:
      'Store something durable about the user — a preference, a name, a plan, how they like ' +
      'things done. Call this on your own initiative whenever they reveal one; do not ask ' +
      'permission and do not announce it unless it matters. Repeating a known fact is safe.',
    inputSchema: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'The fact, in plain words.' } },
      required: ['fact'],
    },
  },
  {
    name: 'recall',
    description:
      'Search what JARVIS knows about the user. Call this before answering anything that ' +
      'depends on their preferences, history or context. An empty query returns recent facts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match. Omit for the most recent facts.' },
        limit: { type: 'number', description: 'How many to return (default 20).' },
      },
    },
  },
  {
    name: 'forget',
    description: 'Remove a stored fact, by its id or by its exact wording.',
    inputSchema: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'The fact id, or its exact text.' } },
      required: ['fact'],
    },
  },
  {
    name: 'add_task',
    description: 'Add something to the user\'s task list.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task done, by its id or by what it says.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string' } },
      required: ['task'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List the open tasks, or all of them including the finished ones.',
    inputSchema: {
      type: 'object',
      properties: { includeDone: { type: 'boolean' } },
    },
  },
  {
    name: 'brain_stats',
    description: 'How much JARVIS currently remembers, and where the brain file lives.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server(
  { name: 'jarvis', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

const text = (value) => ({ content: [{ type: 'text', text: value }] });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'remember': {
      const { fact, added } = await store.update((s) => brain.remember(s, args.fact));
      if (!fact) return text('Nothing to remember — the fact was empty.');
      return text(added ? `Remembered: ${fact.text}` : `Already knew: ${fact.text}`);
    }

    case 'recall': {
      const state = await store.read();
      const hits = brain.recall(state, args.query || '', args.limit || 20);
      if (!hits.length) return text('Nothing stored that matches.');
      return text(hits.map((f) => `- ${f.text}`).join('\n'));
    }

    case 'forget': {
      const { removed } = await store.update((s) => brain.forget(s, args.fact));
      if (!removed.length) return text('No such fact.');
      return text(`Forgot: ${removed.map((f) => f.text).join('; ')}`);
    }

    case 'add_task': {
      const { task } = await store.update((s) => brain.addTask(s, args.task));
      return text(task ? `Added: ${task.text}` : 'Nothing to add.');
    }

    case 'complete_task': {
      const { task } = await store.update((s) => brain.completeTask(s, args.task));
      return text(task ? `Done: ${task.text}` : 'No open task matches that.');
    }

    case 'list_tasks': {
      const state = await store.read();
      const tasks = brain.listTasks(state, { includeDone: Boolean(args.includeDone) });
      if (!tasks.length) return text('Nothing on the list.');
      return text(tasks.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.text}`).join('\n'));
    }

    case 'brain_stats': {
      const s = brain.stats(await store.read());
      return text(
        `${s.facts} facts, ${s.openTasks} open tasks (${s.tasks} total).\nBrain file: ${store.file}`,
      );
    }

    default:
      return { ...text(`Unknown tool "${name}".`), isError: true };
  }
});

// The whole brain, readable in one go, for when the host wants context rather
// than a search.
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'jarvis://brain/facts',
      name: 'What JARVIS knows about you',
      description: 'Every stored fact, newest first.',
      mimeType: 'text/plain',
    },
    {
      uri: 'jarvis://brain/tasks',
      name: 'JARVIS task list',
      description: 'Open and completed tasks.',
      mimeType: 'text/plain',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const state = await store.read();

  if (uri === 'jarvis://brain/facts') {
    const body = [...state.facts]
      .sort((a, b) => b.at - a.at)
      .map((f) => `- ${f.text}`)
      .join('\n');
    return { contents: [{ uri, mimeType: 'text/plain', text: body || 'Nothing stored yet.' }] };
  }

  if (uri === 'jarvis://brain/tasks') {
    const body = state.tasks.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.text}`).join('\n');
    return { contents: [{ uri, mimeType: 'text/plain', text: body || 'Nothing on the list.' }] };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// The persona, so the host can be told to *be* JARVIS rather than merely to
// use its memory.
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'jarvis',
      description: 'Take on the JARVIS persona, with its memory and its habits.',
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== 'jarvis') throw new Error('Unknown prompt.');
  const state = await store.read();
  const known = brain.recall(state, '', 40);
  const memory = known.length
    ? `\n\nWhat you already know about them:\n${known.map((f) => `- ${f.text}`).join('\n')}`
    : '';
  return {
    messages: [
      { role: 'user', content: { type: 'text', text: `${PERSONA}${memory}` } },
    ],
  };
});

await server.connect(new StdioServerTransport());
