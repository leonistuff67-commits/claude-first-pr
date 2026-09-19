/**
 * Conversation-history repair.
 *
 * The Messages API has one hard rule about tools: every `tool_use` block in an
 * assistant message must be answered by a `tool_result` block carrying the same
 * id in the very next message. Break it and the API rejects the whole request
 * with "tool_use ids were found without tool_result blocks immediately after".
 *
 * A transcript can end up violating that rule without anyone doing anything
 * wrong — the model can stop mid-tool-call when it hits the token ceiling, a
 * turn can be cut short, or an old build can have stored a half-finished round.
 * Because the transcript is persisted, one bad round poisons every later
 * request: the assistant never gets another word in until it is cleaned up.
 *
 * So the transcript is repaired on the way in and on the way out, rather than
 * trusted. These functions are pure so they can be tested without a browser.
 */

/** Blocks the API accepts; anything else we added for our own use is dropped. */
const BLOCK_FIELDS = {
  text: ['type', 'text'],
  tool_use: ['type', 'id', 'name', 'input'],
  tool_result: ['type', 'tool_use_id', 'content', 'is_error'],
  image: ['type', 'source'],
  thinking: ['type', 'thinking', 'signature'],
};

/** Strip bookkeeping fields (e.g. a parse-error note) the API would reject. */
function cleanBlock(block) {
  const allowed = BLOCK_FIELDS[block?.type];
  if (!allowed) return block;
  const out = {};
  for (const key of allowed) if (key in block) out[key] = block[key];
  return out;
}

const blocksOf = (message) => (Array.isArray(message?.content) ? message.content : []);
const idsAnsweredBy = (message) =>
  new Set(blocksOf(message).filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id));

/**
 * Return a transcript the API will accept: every `tool_use` is answered by the
 * message right after it, and every `tool_result` answers the message right
 * before it. Unpaired blocks are dropped rather than invented — a tool call
 * that was never run has no result worth making up, and its arguments may have
 * been truncated mid-JSON.
 */
export function repair(messages) {
  const list = Array.isArray(messages) ? messages : [];

  // Pass 1: drop tool_use blocks the next message does not answer.
  const kept = [];
  const answeredIds = new Set();
  for (let i = 0; i < list.length; i++) {
    const message = list[i];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
      kept.push(message);
      continue;
    }
    const answers = idsAnsweredBy(list[i + 1]);
    const content = message.content.filter((b) => b?.type !== 'tool_use' || answers.has(b.id));
    for (const b of content) if (b?.type === 'tool_use') answeredIds.add(b.id);
    kept.push({ ...message, content });
  }

  // Pass 2: drop tool_result blocks whose call did not survive, then drop any
  // message left with nothing to say.
  const out = [];
  for (const message of kept) {
    if (!Array.isArray(message?.content)) {
      if (message?.content) out.push(message);
      continue;
    }
    const prev = out[out.length - 1];
    const calls = new Set(
      blocksOf(prev).filter((b) => b?.type === 'tool_use' && answeredIds.has(b.id)).map((b) => b.id),
    );
    const content = message.content
      .filter((b) => b?.type !== 'tool_result' || calls.has(b.tool_use_id))
      .map(cleanBlock);
    if (content.length) out.push({ ...message, content });
  }
  return out;
}

/**
 * Trim the transcript to the most recent `limit` messages, repair it, and drop
 * leading messages until it opens on a plain user turn — a window cut anywhere
 * else would start with an answer to a question the model can no longer see.
 */
export function sanitize(messages, limit = 40) {
  let out = repair((Array.isArray(messages) ? messages : []).slice(-limit));
  while (out.length) {
    const first = out[0];
    const orphanResult = blocksOf(first).some((b) => b?.type === 'tool_result');
    if (first.role === 'user' && !orphanResult) break;
    out = out.slice(1);
  }
  return out;
}
