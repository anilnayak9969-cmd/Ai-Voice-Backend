// One conversational turn: stream Claude's reply, run any tools it asks for,
// feed results back, and repeat until it answers in plain speech.

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './brand.js';
import { baseParams, client as defaultClient, fallbackParams } from './llm.js';
import { TOOL_DEFINITIONS, TOOL_FILLERS, executeTool } from './tools.js';

const MAX_TOOL_ROUNDS = 5;
const MAX_JSON_RETRIES = 2;

const LINES = {
  refusal: "I'm sorry, I can't help with that. I can help with your Aura Skincare orders, products and policies.",
  confused: "Sorry, I didn't quite get that. Could you please say it again?",
};

// After a mid-output refusal fallback, model-internal blocks that come before
// the last `fallback` marker must not be echoed back; text blocks may be.
function contentForHistory(content) {
  const lastFallback = content.findLastIndex((block) => block.type === 'fallback');
  if (lastFallback === -1) return content;
  return content.filter((block, i) => i > lastFallback || block.type === 'text');
}

/**
 * @param session  call session (history is appended to only when the turn completes)
 * @param userContent  what Claude sees as the customer's message
 * @param emit  (event, data) => void, streams events to the browser
 * @param signal  AbortSignal, fired when the customer barges in / disconnects
 */
export async function runTurn(session, userContent, { emit, signal, client = defaultClient }) {
  const turn = [{ role: 'user', content: userContent }];
  let spoken = '';
  let endCall = false;
  let newRound = false;

  const say = (text) => {
    if (!text) return;
    // Keep text from separate tool rounds apart ("...pull that up.Your order"),
    // but never touch deltas within a round: they split mid-word.
    const chunk = newRound && spoken && !/\s$/.test(spoken) && !/^\s/.test(text) ? ` ${text}` : text;
    newRound = false;
    spoken += chunk;
    emit('text', { delta: chunk });
  };

  const finishWith = (line) => {
    newRound = true;
    say(line);
    turn.push({ role: 'assistant', content: line });
  };

  let jsonRetries = 0;
  for (let round = 0; ; round++) {
    newRound = true;
    if (round > MAX_TOOL_ROUNDS) {
      finishWith(LINES.confused);
      break;
    }

    const stream = client.beta.messages.stream(
      {
        ...baseParams(),
        ...fallbackParams(),
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFINITIONS,
        cache_control: { type: 'ephemeral' },
        messages: [...session.messages, ...turn],
      },
      { signal },
    );

    let message;
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          // Opus-class models keep pre-tool narration in thinking, so give the
          // customer a short filler instead of dead air while the tool runs.
          const filler = TOOL_FILLERS[event.content_block.name];
          if (filler && !spoken.trim()) say(`${filler} `);
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          say(event.delta.text);
        }
      }
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only an unparseable streamed tool input is retried; API errors and
      // aborts (APIUserAbortError extends APIError) propagate.
      if (err instanceof Anthropic.APIError || signal?.aborted || jsonRetries++ >= MAX_JSON_RETRIES) throw err;
      console.warn('[agent] tool input was not parseable JSON, re-issuing the round');
      round--;
      continue;
    }

    if (message.stop_reason === 'refusal') {
      finishWith(LINES.refusal);
      break;
    }

    const content = contentForHistory(message.content);
    const toolUses = content.filter((block) => block.type === 'tool_use');

    if (toolUses.length === 0) {
      turn.push({ role: 'assistant', content });
      if (!spoken.trim()) finishWith(LINES.confused);
      break;
    }

    if (message.stop_reason === 'max_tokens') {
      // A tool input cut off mid-stream can still look valid; never run it.
      finishWith(LINES.confused);
      break;
    }

    turn.push({ role: 'assistant', content });

    const results = toolUses.map((toolUse) => {
      const { content: result, isError } = executeTool(session, toolUse.name, toolUse.input);
      if (toolUse.name === 'end_call') endCall = true;
      const entry = { name: toolUse.name, input: toolUse.input, result, isError };
      session.toolLog.push({ ...entry, at: new Date().toISOString() });
      emit('tool', entry);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
        ...(isError && { is_error: true }),
      };
    });
    turn.push({ role: 'user', content: results });

    // Hanging up needs no further model output.
    if (toolUses.every((toolUse) => toolUse.name === 'end_call')) break;
  }

  // Commit only completed turns; an aborted turn (barge-in) never gets here.
  session.messages.push(...turn);
  return { text: spoken.trim(), endCall };
}
