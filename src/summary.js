// Post-call structured outcome, produced with Claude structured outputs so the
// JSON always matches the schema. Falls back to a rule-based summary if the
// LLM call fails, so ending a call never errors.

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { baseParams, client, hasCredentials } from './llm.js';

const INTENTS = [
  'ORDER_TRACKING',
  'ORDER_CANCELLATION',
  'RETURN_OR_REFUND',
  'DAMAGED_OR_DEFECTIVE_PRODUCT',
  'SHIPPING_POLICY',
  'PAYMENT_OR_COD',
  'PRODUCT_QUERY',
  'OUT_OF_SCOPE',
  'GENERAL_INQUIRY',
  'NO_INTERACTION',
];

const RESOLUTIONS = ['RESOLVED', 'PARTIALLY_RESOLVED', 'UNRESOLVED', 'ESCALATED'];
const SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'];

// The SDK turns enum constraints into descriptions, so enums are declared as
// strings listing the allowed values and snapped to a valid value afterwards;
// one unexpected label shouldn't throw away the whole summary.
const oneOf = (values, description) => z.string().describe(`${description} One of: ${values.join(', ')}.`);

const OutcomeSchema = z.object({
  customer_intent: oneOf(INTENTS, 'Primary reason for the call.'),
  secondary_intents: z.array(oneOf(INTENTS, 'Another intent raised.')).describe('Other intents raised, excluding the primary one.'),
  order_id: z.string().nullable().describe('Main order discussed, e.g. ORD-101, or null.'),
  resolution_status: oneOf(
    RESOLUTIONS,
    'RESOLVED if the customer got a clear answer, including a policy-based "no". ESCALATED if a ticket was raised. UNRESOLVED if the question was left open.',
  ),
  call_summary: z.string().describe('Two or three sentences in past tense, factual, for a support dashboard.'),
  actions_taken: z.array(z.string()).describe('Concrete actions: lookups, cancellations, tickets raised (include ticket IDs).'),
  policy_decisions: z.array(z.string()).describe('Policy rules applied, e.g. "Return declined: outside 7-day window". Empty if none.'),
  customer_sentiment: oneOf(SENTIMENTS, 'Customer mood by the end of the call.'),
  follow_up_required: z.boolean(),
});

const snap = (value, allowed, fallback) => {
  const v = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return allowed.includes(v) ? v : fallback;
};

function normalizeOutcome(o) {
  return {
    ...o,
    customer_intent: snap(o.customer_intent, INTENTS, 'GENERAL_INQUIRY'),
    secondary_intents: [...new Set(o.secondary_intents.map((i) => snap(i, INTENTS, null)).filter(Boolean))],
    resolution_status: snap(o.resolution_status, RESOLUTIONS, 'UNRESOLVED'),
    customer_sentiment: snap(o.customer_sentiment, SENTIMENTS, 'NEUTRAL'),
  };
}

const SUMMARY_SYSTEM = `You analyse completed customer support calls for Aura Skincare and produce a structured outcome record. Base every field strictly on the transcript and tool log. Do not infer facts that aren't there.`;

function renderTranscript(session) {
  const lines = session.transcript.map((entry) => {
    const who = entry.role === 'customer' ? 'Customer' : entry.role === 'agent' ? 'Aria' : 'System';
    return `${who}: ${entry.text}`;
  });
  const tools = session.toolLog.map(
    (t) => `${t.name}(${JSON.stringify(t.input)}) -> ${JSON.stringify(t.result)}`,
  );
  return `TRANSCRIPT\n${lines.join('\n')}\n\nTOOL LOG\n${tools.join('\n') || '(none)'}`;
}

function ruleBasedOutcome(session) {
  const customerSpoke = session.transcript.some((e) => e.role === 'customer');
  const names = new Set(session.toolLog.map((t) => t.name));
  const orderCall = session.toolLog.find((t) => t.result?.order?.order_id);
  let intent = 'GENERAL_INQUIRY';
  if (!customerSpoke) intent = 'NO_INTERACTION';
  else if (names.has('cancel_order')) intent = 'ORDER_CANCELLATION';
  else if (names.has('check_return_eligibility')) intent = 'RETURN_OR_REFUND';
  else if (names.has('get_order_details')) intent = 'ORDER_TRACKING';
  return {
    customer_intent: intent,
    secondary_intents: [],
    order_id: orderCall?.result.order.order_id ?? null,
    resolution_status: session.tickets.length ? 'ESCALATED' : 'UNRESOLVED',
    call_summary: customerSpoke
      ? 'Automatic summary unavailable; see transcript and tool log for details.'
      : 'Call ended before the customer said anything.',
    actions_taken: session.toolLog.map((t) => `${t.name} ${JSON.stringify(t.input)}`),
    policy_decisions: [],
    customer_sentiment: 'NEUTRAL',
    follow_up_required: session.tickets.length > 0,
  };
}

export async function summarizeCall(session) {
  const customerSpoke = session.transcript.some((e) => e.role === 'customer');
  if (!customerSpoke || !hasCredentials()) return { outcome: ruleBasedOutcome(session), generatedBy: 'rules' };

  try {
    const base = baseParams();
    const response = await client.messages.parse({
      ...base,
      max_tokens: 4000,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: renderTranscript(session) }],
      output_config: { ...base.output_config, format: zodOutputFormat(OutcomeSchema) },
    });
    if (response.parsed_output) return { outcome: normalizeOutcome(response.parsed_output), generatedBy: 'llm' };
    console.warn('[summary] no parsed output, stop_reason =', response.stop_reason);
  } catch (err) {
    console.error('[summary] LLM summary failed:', err.message);
  }
  return { outcome: ruleBasedOutcome(session), generatedBy: 'rules' };
}
