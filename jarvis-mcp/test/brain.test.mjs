/**
 * The brain is where all the behaviour lives, so it carries the bulk of the
 * tests. Everything here is pure: no server, no files, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as brain from '../src/brain.js';

test('a fact is stored once, however often it is offered', () => {
  let s = brain.createState();
  const first = brain.remember(s, 'I take the 8am train');
  s = first.state;
  assert.equal(first.added, true);

  // The assistant volunteers facts unprompted, so it will repeat itself.
  const again = brain.remember(s, '  I take the 8AM train  ');
  assert.equal(again.added, false);
  assert.equal(again.state.facts.length, 1);
});

test('an empty fact is refused rather than stored blank', () => {
  const { state, fact, added } = brain.remember(brain.createState(), '   ');
  assert.equal(fact, null);
  assert.equal(added, false);
  assert.equal(state.facts.length, 0);
});

test('recall ranks by how much of the query a fact covers', () => {
  let s = brain.createState();
  s = brain.remember(s, 'I drink oat milk flat whites').state;
  s = brain.remember(s, 'I drink water in the morning').state;
  s = brain.remember(s, 'My sister is called Mina').state;

  const hits = brain.recall(s, 'drink oat milk');
  assert.equal(hits[0].text, 'I drink oat milk flat whites');
  assert.equal(hits.length, 2);
});

test('an empty query returns recent facts rather than nothing', () => {
  let s = brain.createState();
  s = brain.remember(s, 'one').state;
  s = brain.remember(s, 'two').state;
  assert.equal(brain.recall(s, '').length, 2);
});

test('recall respects the limit', () => {
  let s = brain.createState();
  for (let i = 0; i < 30; i++) s = brain.remember(s, `fact number ${i}`).state;
  assert.equal(brain.recall(s, '', 5).length, 5);
});

test('a fact can be forgotten by id or by its wording', () => {
  let s = brain.createState();
  const stored = brain.remember(s, 'I hate coriander');
  const fact = stored.fact;
  s = brain.remember(stored.state, 'I like olives').state;

  const byId = brain.forget(s, fact.id);
  assert.equal(byId.removed.length, 1);
  assert.equal(byId.state.facts.length, 1);

  const byText = brain.forget(s, 'i hate coriander');
  assert.equal(byText.removed.length, 1);
  assert.equal(byText.state.facts[0].text, 'I like olives');
});

test('forgetting something unknown changes nothing', () => {
  const s = brain.remember(brain.createState(), 'keep me').state;
  const { state, removed } = brain.forget(s, 'never said this');
  assert.equal(removed.length, 0);
  assert.equal(state.facts.length, 1);
});

test('tasks are added, listed open, and completed by text', () => {
  let s = brain.createState();
  s = brain.addTask(s, 'book the dentist').state;
  s = brain.addTask(s, 'renew passport').state;
  assert.equal(brain.listTasks(s).length, 2);

  const done = brain.completeTask(s, 'book the dentist');
  s = done.state;
  assert.equal(done.task.done, true);
  assert.equal(brain.listTasks(s).length, 1);
  assert.equal(brain.listTasks(s, { includeDone: true }).length, 2);
});

test('completing a task matches on a fragment when nothing matches exactly', () => {
  let s = brain.addTask(brain.createState(), 'renew the passport before June').state;
  const { task } = brain.completeTask(s, 'passport');
  assert.ok(task);
  assert.equal(task.done, true);
});

test('completing an unknown task reports nothing rather than guessing', () => {
  const s = brain.addTask(brain.createState(), 'water the plants').state;
  assert.equal(brain.completeTask(s, 'file taxes').task, null);
});

test('an already-completed task is not completed twice', () => {
  let s = brain.addTask(brain.createState(), 'call mum').state;
  s = brain.completeTask(s, 'call mum').state;
  assert.equal(brain.completeTask(s, 'call mum').task, null);
});

test('stats describe the brain', () => {
  let s = brain.createState();
  s = brain.remember(s, 'a fact').state;
  s = brain.addTask(s, 'a task').state;
  s = brain.addTask(s, 'a done task').state;
  s = brain.completeTask(s, 'a done task').state;

  const out = brain.stats(s);
  assert.equal(out.facts, 1);
  assert.equal(out.tasks, 2);
  assert.equal(out.openTasks, 1);
  assert.ok(out.newestFact > 0);
});

test('a browser export folds in, and folds in idempotently', () => {
  const exported = {
    facts: [{ id: 'a', text: 'I live in Leeds', at: 1 }, { id: 'b', text: 'I code at night', at: 2 }],
    tasks: [{ id: 'c', text: 'ship the app', done: false, at: 3 }],
    settings: { apiKey: 'sk-should-be-ignored' },
    history: [{ role: 'user', content: 'not a fact' }],
  };

  let s = brain.remember(brain.createState(), 'I live in Leeds').state;
  const first = brain.merge(s, exported);
  assert.equal(first.added.facts, 1);
  assert.equal(first.added.tasks, 1);
  assert.equal(first.state.facts.length, 2);

  // Re-importing the same export must not double anything up.
  const second = brain.merge(first.state, exported);
  assert.equal(second.added.facts, 0);
  assert.equal(second.added.tasks, 0);
});

test('normalise throws away junk instead of trusting the file', () => {
  const s = brain.normalise({
    facts: [{ text: 'good' }, { text: '   ' }, null, { nope: 1 }, 'string'],
    tasks: 'not an array',
    extra: 'ignored',
  });
  assert.equal(s.facts.length, 1);
  assert.equal(s.facts[0].text, 'good');
  assert.ok(s.facts[0].id);
  assert.deepEqual(s.tasks, []);
  assert.equal(s.extra, undefined);
});

test('normalise copes with nothing at all', () => {
  assert.deepEqual(brain.normalise(undefined), { facts: [], tasks: [] });
  assert.deepEqual(brain.normalise('nonsense'), { facts: [], tasks: [] });
});
