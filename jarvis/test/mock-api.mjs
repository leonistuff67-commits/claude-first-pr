/**
 * A stand-in for POST /v1/messages that streams SSE the way the real API does.
 * The first request answers with text plus a set_timer tool call; once it sees a
 * tool_result come back it answers with plain text and ends the turn.
 */
import http from 'node:http';

export function startMockApi(port = 0) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}');
    const sawToolResult = payload.messages?.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
    );

    const sse = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse({ type: 'message_start', message: { model: payload.model } });

    if (!sawToolResult) {
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const part of ['Setting ', 'that ', 'now.']) {
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } });
      }
      sse({ type: 'content_block_stop', index: 0 });
      sse({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_x', name: 'set_timer', input: {} },
      });
      sse({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"seconds": 90, "label": "tea"}' },
      });
      sse({ type: 'content_block_stop', index: 1 });
      sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    } else {
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sse({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Tea timer running for ninety seconds.' },
      });
      sse({ type: 'content_block_stop', index: 0 });
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    }

    sse({ type: 'message_stop' });
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMockApi(Number(process.env.MOCK_PORT) || 9911);
  console.log(`mock api listening on ${port}`);
}
