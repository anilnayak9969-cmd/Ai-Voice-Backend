// Tools the agent can call. Policy decisions (can this be returned? cancelled?)
// are made here in code, not left to the model, so a persuasive customer can't
// talk the agent into promising something the policy doesn't allow.

import { z } from 'zod';
import { POLICIES } from './brand.js';
import { describeOrder, normalizeOrderId } from './orders.js';

export const TOOL_DEFINITIONS = [
  {
    name: 'get_order_details',
    description:
      'Look up a customer order in the Aura Skincare order system. Returns status, product, value, courier and delivery info, or found=false if no such order exists. Call this before saying anything about a specific order.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'Order ID as heard from the customer, e.g. "ORD-101", "ord 101" or "101".',
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'check_return_eligibility',
    description:
      'Apply the Aura Skincare return / replacement policy. Provide order_id when known; otherwise provide days_since_delivery as stated by the customer. Returns eligible=true/false with the reason and the allowed next step.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order ID, if the customer gave one.' },
        days_since_delivery: {
          type: 'number',
          description: 'Days since delivery as stated by the customer. Only used when there is no order_id.',
        },
        product_opened: {
          type: 'boolean',
          description: 'Whether the product has been opened or used. Omit if unknown.',
        },
        reason: {
          type: 'string',
          enum: ['changed_mind', 'damaged_or_defective', 'wrong_item', 'other'],
          description: 'Why the customer wants to return it.',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'cancel_order',
    description:
      'Cancel an order. Only allowed while its status is Processing. Call ONLY after the customer has explicitly confirmed they want to cancel this order.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        reason: { type: 'string', description: 'Short reason given by the customer, if any.' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Raise a ticket for the human support team, e.g. damaged product photos, complaints, requests outside your scope, or when the customer asks for a human.',
    input_schema: {
      type: 'object',
      properties: {
        issue_summary: { type: 'string', description: 'One or two sentence summary for the support team.' },
        order_id: { type: 'string' },
        priority: { type: 'string', enum: ['normal', 'high'] },
      },
      required: ['issue_summary'],
    },
  },
  {
    name: 'end_call',
    description:
      'Hang up the call. Use only after you have said goodbye and the customer has nothing else to ask.',
    input_schema: { type: 'object', properties: {} },
  },
].map((tool) => ({ ...tool, eager_input_streaming: true }));

// Runtime validation: with eager input streaming the API does not validate
// tool input, so every input is checked here before a tool runs.
const SCHEMAS = {
  get_order_details: z.object({ order_id: z.string() }),
  check_return_eligibility: z.object({
    order_id: z.string().optional(),
    days_since_delivery: z.number().nonnegative().optional(),
    product_opened: z.boolean().optional(),
    reason: z.enum(['changed_mind', 'damaged_or_defective', 'wrong_item', 'other']),
  }),
  cancel_order: z.object({ order_id: z.string(), reason: z.string().optional() }),
  escalate_to_human: z.object({
    issue_summary: z.string().min(1),
    order_id: z.string().optional(),
    priority: z.enum(['normal', 'high']).optional(),
  }),
  end_call: z.object({}).passthrough(),
};

// Short spoken fillers so the customer hears something while a tool runs.
export const TOOL_FILLERS = {
  get_order_details: 'Sure, let me pull that up.',
  check_return_eligibility: 'Let me check that against our return policy.',
  cancel_order: 'Okay, one moment.',
  escalate_to_human: 'Let me raise this with our team.',
};

function lookup(session, rawId) {
  const orderId = normalizeOrderId(rawId);
  if (!orderId) {
    return {
      error: {
        found: false,
        reason: 'INVALID_FORMAT',
        heard: rawId,
        instruction: 'The ID has no order number in it. Ask the customer to repeat their order ID (format: ORD followed by digits).',
      },
    };
  }
  const order = session.orders.get(orderId);
  if (!order) {
    return {
      error: {
        found: false,
        reason: 'NOT_FOUND',
        searched_for: orderId,
        instruction: 'No such order exists. Tell the customer you could not locate it and ask them to repeat or verify the ID. Do not invent details.',
      },
    };
  }
  return { order };
}

function getOrderDetails(session, { order_id }) {
  const { order, error } = lookup(session, order_id);
  if (error) return error;
  return { found: true, order: describeOrder(order) };
}

function checkReturnEligibility(session, input) {
  const { returns } = POLICIES;
  let daysSinceDelivery = input.days_since_delivery;
  let orderView = null;

  if (input.order_id) {
    const { order, error } = lookup(session, input.order_id);
    if (error) return error;
    orderView = describeOrder(order);
    if (order.status !== 'Delivered') {
      const alternatives = {
        Processing: 'The order has not shipped yet, so the customer can cancel it instead (confirm first, then cancel_order).',
        'Out for Delivery': 'It has not been delivered yet. It cannot be cancelled now, but the customer may refuse the delivery at the doorstep.',
        Shipped: 'It has not been delivered yet. It cannot be cancelled now, but the customer may refuse the delivery at the doorstep.',
        Cancelled: 'This order is already cancelled.',
      };
      return {
        eligible: false,
        order: orderView,
        reason: `Returns apply only to delivered orders. Current status: ${order.status}.`,
        next_step: alternatives[order.status] ?? 'Explain that returns apply only after delivery.',
      };
    }
    daysSinceDelivery = orderView.days_since_delivery;
  }

  if (daysSinceDelivery == null) {
    return {
      eligible: null,
      missing: 'order_id or days_since_delivery',
      instruction: 'Ask for the order ID (preferred) or how many days ago it was delivered.',
    };
  }

  const result = { order: orderView ?? undefined, days_since_delivery: daysSinceDelivery };

  if (input.reason === 'damaged_or_defective' || input.reason === 'wrong_item') {
    const withinWindow = daysSinceDelivery * 24 <= returns.damaged_report_window_hours;
    return {
      ...result,
      eligible: withinWindow,
      policy: `Damaged or defective products must be reported within ${returns.damaged_report_window_hours} hours of delivery, with photos, for a replacement.`,
      reason: withinWindow
        ? 'Reported within the 48-hour window.'
        : `Delivered ${daysSinceDelivery} days ago, which is outside the 48-hour reporting window.`,
      next_step: withinWindow
        ? 'Eligible for a replacement once photos are shared. Offer to raise a ticket with escalate_to_human so the team can collect photos and arrange it.'
        : 'Not eligible for a replacement under policy. Be empathetic; you may offer to raise a ticket for the team to review, but promise nothing.',
    };
  }

  const reasons = [];
  if (daysSinceDelivery > returns.window_days) {
    reasons.push(`delivered ${daysSinceDelivery} days ago, outside the ${returns.window_days}-day return window`);
  }
  if (input.product_opened === true) {
    reasons.push('the product has been opened or used');
  }
  const eligible = reasons.length === 0 && input.product_opened === false;

  return {
    ...result,
    eligible: reasons.length > 0 ? false : input.product_opened === undefined ? null : eligible,
    policy: `Returns are accepted within ${returns.window_days} days of delivery for ${returns.condition}.`,
    reason:
      reasons.length > 0
        ? `Not eligible: ${reasons.join(' and ')}.`
        : input.product_opened === undefined
          ? 'Within the return window, but we need to know whether the product is unopened.'
          : 'Within the return window and unopened.',
    next_step:
      reasons.length > 0
        ? 'Politely explain this falls outside the return policy. Do not promise a refund.'
        : input.product_opened === undefined
          ? 'Ask whether the product is unopened and unused, in its original packaging.'
          : 'Eligible for return. Tell the customer the return request is noted and our team will share pickup details; do not promise a refund timeline.',
  };
}

function cancelOrder(session, { order_id, reason }) {
  const { order, error } = lookup(session, order_id);
  if (error) return error;
  if (order.status === 'Cancelled') {
    return { cancelled: false, reason: 'Order is already cancelled.', order: describeOrder(order) };
  }
  if (order.status !== 'Processing') {
    return {
      cancelled: false,
      reason: `Orders can only be cancelled while Processing. This order is "${order.status}".`,
      next_step:
        order.status === 'Delivered'
          ? 'It is already delivered; check return eligibility instead if they want to send it back.'
          : 'It cannot be cancelled now, but the customer may refuse the delivery at the doorstep.',
      order: describeOrder(order),
    };
  }
  order.status = 'Cancelled';
  order.notes = `Cancelled during support call${reason ? ` (${reason})` : ''}.`;
  return {
    cancelled: true,
    order: describeOrder(order),
    next_step: 'Confirm the cancellation to the customer. Do not state a refund timeline; none is defined in policy.',
  };
}

function escalateToHuman(session, { issue_summary, order_id, priority = 'normal' }) {
  const ticketId = `AUR-${Math.floor(10000 + Math.random() * 90000)}`;
  const ticket = {
    ticket_id: ticketId,
    order_id: order_id ? normalizeOrderId(order_id) : null,
    priority,
    issue_summary,
  };
  session.tickets.push(ticket);
  return {
    ...ticket,
    created: true,
    next_step: 'Tell the customer a ticket has been raised and the support team will get in touch. Do not promise a specific time or outcome.',
  };
}

const HANDLERS = {
  get_order_details: getOrderDetails,
  check_return_eligibility: checkReturnEligibility,
  cancel_order: cancelOrder,
  escalate_to_human: escalateToHuman,
  end_call: () => ({ ok: true, instruction: 'The call will end after your goodbye is spoken.' }),
};

// Returns { content, isError }.
export function executeTool(session, name, rawInput) {
  const schema = SCHEMAS[name];
  const handler = HANDLERS[name];
  if (!schema || !handler) {
    return { content: { error: `Unknown tool: ${name}` }, isError: true };
  }
  const parsed = schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      content: { error: 'INVALID_INPUT', details: parsed.error.issues.map((i) => i.message), received: rawInput },
      isError: true,
    };
  }
  try {
    return { content: handler(session, parsed.data), isError: false };
  } catch (err) {
    console.error(`[tool ${name}]`, err);
    return { content: { error: 'Tool failed unexpectedly. Apologise and offer to raise a ticket.' }, isError: true };
  }
}
