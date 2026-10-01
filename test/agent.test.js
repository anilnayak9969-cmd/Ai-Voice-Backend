import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn } from '../src/agent.js';
import { createSession } from '../src/sessions.js';

// Minimal stand-in for client.beta.messages.stream(): replays scripted
// assistant messages as stream events and records each request.
function fakeClient(script) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        stream(params) {
          requests.push(structuredClone(params));
          const message = script.shift();
          if (!message) throw new Error('no scripted response left');
          return {
            async *[Symbol.asyncIterator]() {
              for (const [index, block] of message.content.entries()) {
                yield { type: 'content_block_start', index, content_block: { ...block, text: '' } };
                if (block.type === 'text') {
                  // Real deltas split mid-word; so do these.
                  for (const piece of block.text.match(/.{1,5}/gs)) {
                    yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } };
                  }
                }
              }
            },
            finalMessage: async () => message,
          };
        },
      },
    },
  };
}

const text = (t) => ({ type: 'text', text: t });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('order lookup: tool is called, filler is spoken, result is fed back', async () => {
  const session = createSession();
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [toolUse('t1', 'get_order_details', { order_id: 'ORD-101' })] },
    { stop_reason: 'end_turn', content: [text('Your Vitamin C Serum is out for delivery and should reach you by 6 PM today.')] },
  ]);
  const events = [];
  const result = await runTurn(session, 'Where is my order ORD-101?', {
    client,
    emit: (event, data) => events.push({ event, data }),
  });

  assert.equal(
    result.text,
    'Sure, let me pull that up. Your Vitamin C Serum is out for delivery and should reach you by 6 PM today.',
  );
  const streamed = events.filter((e) => e.event === 'text').map((e) => e.data.delta).join('');
  assert.equal(streamed, result.text);
  assert.equal(result.endCall, false);

  const tool = events.find((e) => e.event === 'tool');
  assert.equal(tool.data.result.order.status, 'Out for Delivery');

  // Second request carries the tool_result for the tool_use.
  const second = client.requests[1].messages;
  const toolResult = second.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 't1');

  // History: user, assistant(tool_use), user(tool_result), assistant(text)
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('history is append-only across turns (prompt prefix never changes)', async () => {
  const session = createSession();
  const client = fakeClient([
    { stop_reason: 'end_turn', content: [text('Free delivery is on orders above 499 rupees.')] },
    { stop_reason: 'end_turn', content: [text('COD is available up to 2,500 rupees.')] },
  ]);
  const emit = () => {};
  await runTurn(session, 'Is shipping free?', { client, emit });
  await runTurn(session, 'Can I pay cash?', { client, emit });
  const [first, second] = client.requests;
  assert.equal(first.system, second.system);
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
});

test('end_call ends the turn without another model round-trip', async () => {
  const session = createSession();
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [text('Thank you for calling Aura Skincare, have a lovely day!'), toolUse('t9', 'end_call', {})] },
  ]);
  const result = await runTurn(session, "No that's all, bye", { client, emit: () => {} });
  assert.equal(result.endCall, true);
  assert.equal(client.requests.length, 1);
  assert.match(result.text, /lovely day/);
});

test('refusal is replaced by a safe spoken line', async () => {
  const session = createSession();
  const client = fakeClient([{ stop_reason: 'refusal', content: [] }]);
  const result = await runTurn(session, 'something odd', { client, emit: () => {} });
  assert.match(result.text, /Aura Skincare/);
  assert.equal(session.messages.at(-1).role, 'assistant');
});

test('aborted turn is not committed to history', async () => {
  const session = createSession();
  const controller = new AbortController();
  const client = {
    beta: {
      messages: {
        stream() {
          return {
            async *[Symbol.asyncIterator]() {
              controller.abort();
              const { APIUserAbortError } = await import('@anthropic-ai/sdk');
              throw new APIUserAbortError();
            },
            finalMessage: async () => ({}),
          };
        },
      },
    },
  };
  await assert.rejects(runTurn(session, 'hello', { client, emit: () => {}, signal: controller.signal }));
  assert.equal(session.messages.length, 0);
});
