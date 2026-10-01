import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOrderId } from '../src/orders.js';
import { createSession } from '../src/sessions.js';
import { executeTool } from '../src/tools.js';

const run = (session, name, input) => executeTool(session, name, input).content;

test('normalizeOrderId handles speech-to-text variants', () => {
  assert.equal(normalizeOrderId('ORD-101'), 'ORD-101');
  assert.equal(normalizeOrderId('ord 101'), 'ORD-101');
  assert.equal(normalizeOrderId('ORD101'), 'ORD-101');
  assert.equal(normalizeOrderId('order number 102'), 'ORD-102');
  assert.equal(normalizeOrderId('O R D one zero three'), 'ORD-103');
  assert.equal(normalizeOrderId('one oh one'), 'ORD-101');
  assert.equal(normalizeOrderId('my order'), null);
});

test('get_order_details finds orders and reports unknown IDs without inventing data', () => {
  const session = createSession();
  const found = run(session, 'get_order_details', { order_id: 'ord 101' });
  assert.equal(found.found, true);
  assert.equal(found.order.status, 'Out for Delivery');

  const missing = run(session, 'get_order_details', { order_id: 'ORD-999' });
  assert.equal(missing.found, false);
  assert.equal(missing.reason, 'NOT_FOUND');

  const garbled = run(session, 'get_order_details', { order_id: 'the blue one' });
  assert.equal(garbled.reason, 'INVALID_FORMAT');
});

test('return policy: 20 days + opened is declined', () => {
  const session = createSession();
  const result = run(session, 'check_return_eligibility', {
    days_since_delivery: 20,
    product_opened: true,
    reason: 'changed_mind',
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /7-day/);
});

test('return policy: ORD-102 (delivered 14 days ago) is outside the window', () => {
  const session = createSession();
  const result = run(session, 'check_return_eligibility', { order_id: 'ORD-102', reason: 'changed_mind' });
  assert.equal(result.eligible, false);
  assert.equal(result.days_since_delivery, 14);
});

test('return policy: undelivered order points to cancel / refuse-at-door', () => {
  const session = createSession();
  const result = run(session, 'check_return_eligibility', { order_id: 'ORD-101', reason: 'changed_mind' });
  assert.equal(result.eligible, false);
  assert.match(result.next_step, /refuse/);
});

test('return policy: recent unopened return is eligible; unknown opened state asks', () => {
  const session = createSession();
  assert.equal(
    run(session, 'check_return_eligibility', { days_since_delivery: 3, product_opened: false, reason: 'changed_mind' }).eligible,
    true,
  );
  assert.equal(run(session, 'check_return_eligibility', { days_since_delivery: 3, reason: 'changed_mind' }).eligible, null);
});

test('damaged product must be reported within 48 hours', () => {
  const session = createSession();
  assert.equal(run(session, 'check_return_eligibility', { days_since_delivery: 1, reason: 'damaged_or_defective' }).eligible, true);
  assert.equal(run(session, 'check_return_eligibility', { order_id: 'ORD-102', reason: 'damaged_or_defective' }).eligible, false);
});

test('cancel_order only works while Processing, and is per-call', () => {
  const session = createSession();
  assert.equal(run(session, 'cancel_order', { order_id: 'ORD-101' }).cancelled, false);
  assert.equal(run(session, 'cancel_order', { order_id: 'ORD-103' }).cancelled, true);
  assert.equal(run(session, 'get_order_details', { order_id: 'ORD-103' }).order.status, 'Cancelled');
  assert.equal(run(session, 'cancel_order', { order_id: 'ORD-103' }).cancelled, false);

  const otherCall = createSession();
  assert.equal(run(otherCall, 'get_order_details', { order_id: 'ORD-103' }).order.status, 'Processing');
});

test('invalid tool input is rejected, not executed', () => {
  const session = createSession();
  const { isError } = executeTool(session, 'cancel_order', {});
  assert.equal(isError, true);
  assert.equal(executeTool(session, 'book_flight', { to: 'Goa' }).isError, true);
});
