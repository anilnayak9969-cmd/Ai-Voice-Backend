import { randomUUID } from 'node:crypto';
import { GREETING } from './brand.js';
import { createOrderStore } from './orders.js';

// In-memory call store. Fine for a single-instance demo; at scale this moves
// to Redis (see README, "1,000 conversations a day").
const sessions = new Map();
const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export function createSession() {
  if (sessions.size >= MAX_SESSIONS) {
    const oldestId = sessions.keys().next().value;
    sessions.delete(oldestId);
  }
  const now = new Date();
  const session = {
    id: randomUUID(),
    startedAt: now,
    endedAt: null,
    messages: [], // Claude conversation history (append-only)
    transcript: [{ role: 'agent', text: GREETING, at: now.toISOString() }],
    toolLog: [],
    tickets: [],
    orders: createOrderStore(),
    turns: 0,
    queue: Promise.resolve(), // serialises turns within a call
    result: null,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id) {
  return sessions.get(id) ?? null;
}

// Run turns for one call strictly one after another. If the customer barges
// in, the aborted turn finishes unwinding before the next one starts.
export async function withSessionLock(session, fn) {
  const previous = session.queue;
  let release;
  session.queue = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.startedAt.getTime() < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();
