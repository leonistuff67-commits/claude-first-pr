/**
 * The memory-brain graph: which memories get wired to which.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGraph, keywords } from '../public/js/mind.js';

const fact = (id, text, at = Date.now()) => ({ id, text, at });

test('keywords drop stopwords and short words, and stem plurals', () => {
  const k = keywords('The user prefers espresso over drip coffees');
  assert.ok(k.has('espresso'));
  assert.ok(k.has('coffee'), 'coffees -> coffee');
  assert.ok(!k.has('the'));
  assert.ok(!k.has('over'), 'short words dropped');
  assert.ok(!k.has('prefers'), 'stopword-ish verb dropped');
});

test('memories sharing a meaningful word are wired together', () => {
  const { nodes, edges } = buildGraph([
    fact('a', 'Drinks espresso every morning'),
    fact('b', 'Buys espresso beans from the market'),
    fact('c', 'Runs a marathon in April'),
  ]);
  assert.equal(nodes.length, 3);
  const linked = edges.find((e) => (e.a === 0 && e.b === 1));
  assert.ok(linked, 'the two espresso memories connect');
  assert.ok(linked.weight >= 1);
});

test('an unrelated memory is tethered rather than left floating', () => {
  const { nodes, edges } = buildGraph([
    fact('a', 'Drinks espresso every morning', 1),
    fact('b', 'Buys espresso beans', 2),
    fact('c', 'Completely unrelated marathon plan', 3),
  ]);
  const touchesC = edges.some((e) => e.a === 2 || e.b === 2);
  assert.ok(touchesC, 'orphan gets a tether');
  assert.ok(nodes[2].degree > 0);
});

test('a temporal backbone connects every memory into one graph', () => {
  // Deliberately share no meaningful words, so only the backbone can connect them.
  const subjects = ['piano', 'volcano', 'pretzel', 'satellite', 'origami', 'walrus', 'quartz', 'harmonica'];
  const facts = subjects.map((word, i) => fact(`f${i}`, word, i));
  const { nodes, edges } = buildGraph(facts);

  // Every node reachable from node 0 — one connected organism, no dust.
  const adj = new Map(nodes.map((_, i) => [i, []]));
  for (const e of edges) {
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    for (const next of adj.get(queue.pop())) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  assert.equal(seen.size, facts.length, 'graph is fully connected');
  assert.ok(edges.some((e) => e.temporal), 'temporal threads are marked');
});

test('meaning links are not duplicated by the temporal backbone', () => {
  const { edges } = buildGraph([
    fact('a', 'espresso ritual every morning', 1),
    fact('b', 'espresso beans delivery', 2),
  ]);
  assert.equal(edges.length, 1, 'one edge, not a meaning edge plus a temporal one');
  assert.ok(!edges[0].temporal, 'the meaning link wins');
});

test('degree counts how many synapses a memory has', () => {
  const { nodes } = buildGraph([
    fact('a', 'espresso coffee ritual'),
    fact('b', 'espresso machine repair'),
    fact('c', 'coffee beans delivery'),
  ]);
  assert.ok(nodes[0].degree >= 2, 'the hub memory has the most connections');
});

test('handles zero and one memory without blowing up', () => {
  assert.deepEqual(buildGraph([]), { nodes: [], edges: [] });
  const single = buildGraph([fact('a', 'lonely thought')]);
  assert.equal(single.nodes.length, 1);
  assert.equal(single.edges.length, 0, 'nothing to tether to');
});
