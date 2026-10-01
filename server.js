import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import express from 'express';
import { runTurn } from './src/agent.js';
import { GREETING } from './src/brand.js';
import { hasCredentials, MODEL } from './src/llm.js';
import { listSeedOrders } from './src/orders.js';
import { createSession, getSession, withSessionLock } from './src/sessions.js';
import { summarizeCall } from './src/summary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5000;
const MAX_TEXT_LENGTH = 1000;
const MAX_TURNS_PER_CALL = 60;

const app = express();
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined));
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: MODEL, llmConfigured: hasCredentials() });
});

app.get('/api/orders', (req, res) => {
  res.json(listSeedOrders());
});

app.post('/api/calls', (req, res) => {
  const session = createSession();
  res.status(201).json({ callId: session.id, greeting: GREETING });
});

// Turns the browser's request into what Claude sees, with any system notes
// (silence, low ASR confidence, barge-in) in square brackets.
function buildTurnInput(body) {
  const notes = [];
  if (typeof body.interruptedAfter === 'string') {
    notes.push(
      body.interruptedAfter.trim()
        ? `[customer interrupted you; they only heard: "${body.interruptedAfter.trim().slice(0, 400)}"]`
        : '[customer interrupted you before hearing your reply]',
    );
  }
  if (body.event === 'silence') {
    notes.push('[customer was silent for about 12 seconds]');
    return { content: notes.join(' '), display: null, note: 'Customer silent ~12s' };
  }
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT_LENGTH) : '';
  if (!text) return null;
  if (typeof body.confidence === 'number' && body.confidence > 0 && body.confidence < 0.5) {
    notes.push('[low recognition confidence, the transcript may be inaccurate]');
  }
  return { content: [...notes, text].join(' '), display: text };
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'LLM authentication failed. Check ANTHROPIC_API_KEY on the server.';
  if (err instanceof Anthropic.RateLimitError) return 'LLM rate limit reached. Please try again in a moment.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the LLM service.';
  if (err instanceof Anthropic.APIError) return `LLM error (${err.status ?? 'unknown'}).`;
  return 'Unexpected server error.';
}

// Streams one agent turn as Server-Sent Events: text deltas, tool calls, done.
app.post('/api/calls/:id/turns', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Call not found or expired. Please start a new call.' });
  if (session.endedAt) return res.status(409).json({ error: 'This call has already ended.' });
  if (session.turns >= MAX_TURNS_PER_CALL) return res.status(429).json({ error: 'Turn limit reached for this call.' });

  const input = buildTurnInput(req.body ?? {});
  if (!input) return res.status(400).json({ error: 'Empty message.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const emit = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Browser aborts the request on barge-in: stop generating immediately.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  if (!hasCredentials()) {
    emit('error', {
      message: 'The server has no ANTHROPIC_API_KEY configured.',
      spoken: "Sorry, I'm not able to connect right now. Please try again later.",
    });
    return res.end();
  }

  await withSessionLock(session, async () => {
    if (controller.signal.aborted) return;
    const startedAt = Date.now();
    try {
      const { text, endCall } = await runTurn(session, input.content, { emit, signal: controller.signal });
      session.turns += 1;
      const at = new Date().toISOString();
      if (input.display) session.transcript.push({ role: 'customer', text: input.display, at });
      if (input.note) session.transcript.push({ role: 'event', text: input.note, at });
      for (const tool of session.toolLog.filter((t) => !t.logged)) {
        tool.logged = true;
        session.transcript.push({ role: 'event', text: `Tool ${tool.name}(${JSON.stringify(tool.input)})`, at: tool.at });
      }
      if (text) session.transcript.push({ role: 'agent', text, at });
      emit('done', { text, endCall, latencyMs: Date.now() - startedAt });
    } catch (err) {
      if (controller.signal.aborted) return; // barge-in; turn discarded
      console.error('[turn]', err);
      emit('error', {
        message: describeError(err),
        spoken: "Sorry, I'm having a little trouble on my side. Could you please say that again?",
      });
    } finally {
      res.end();
    }
  });
});

app.post('/api/calls/:id/end', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Call not found or expired.' });

  // Let an in-flight turn settle, then summarise once (End Call may be clicked twice).
  await withSessionLock(session, async () => {
    if (!session.result) {
      session.endedAt = new Date();
      const { outcome, generatedBy } = await summarizeCall(session);
      session.result = {
        callId: session.id,
        transcript: session.transcript,
        outcome,
        meta: {
          started_at: session.startedAt.toISOString(),
          ended_at: session.endedAt.toISOString(),
          duration_seconds: Math.round((session.endedAt - session.startedAt) / 1000),
          customer_turns: session.transcript.filter((e) => e.role === 'customer').length,
          tools_used: session.toolLog.map((t) => t.name),
          tickets: session.tickets,
          summary_generated_by: generatedBy,
          model: MODEL,
        },
      };
    }
  });
  res.json(session.result);
});

// Serve the built React app when it exists (single-service deploy).
const clientDist = path.resolve(here, '../Frontend/ai-voice/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  // API-only deploy (frontend hosted elsewhere): answer the bare URL instead of "Cannot GET /".
  app.get('/', (req, res) => {
    res.json({ ok: true, service: 'Aura voice agent API', health: '/api/health' });
  });
}

// Unknown routes get JSON instead of Express's HTML "Cannot GET" page.
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// On Vercel the platform invokes the exported app; locally we listen ourselves.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Aura voice agent API on http://localhost:${PORT} (model: ${MODEL}, key configured: ${hasCredentials()})`);
  });
}

export default app;
