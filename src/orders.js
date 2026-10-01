// Mock order database (from the assignment brief).
// Dates are stored relative to "now" so the data stays consistent whenever the
// demo is opened ("delivered 14 days ago", "expected by 6 PM today").

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const SEED_ORDERS = [
  {
    order_id: 'ORD-101',
    customer_name: 'Priya Sharma',
    product: 'Vitamin C Serum (30ml)',
    value_inr: 699,
    status: 'Out for Delivery',
    courier: 'BlueDart',
    tracking_number: 'BD-982103',
    ordered_ago_ms: 3 * DAY,
    delivered_ago_ms: null,
    notes: 'BlueDart — BD-982103. Expected by 6 PM today',
  },
  {
    order_id: 'ORD-102',
    customer_name: 'Rahul Verma',
    product: 'Hydrating Sunscreen SPF 50',
    value_inr: 499,
    status: 'Delivered',
    courier: 'Delhivery',
    tracking_number: 'DL-441029',
    ordered_ago_ms: 18 * DAY,
    delivered_ago_ms: 14 * DAY,
    notes: 'Delhivery — DL-441029. Delivered 14 days ago',
  },
  {
    order_id: 'ORD-103',
    customer_name: 'Ananya Patel',
    product: 'Green Tea Face Wash + Toner',
    value_inr: 850,
    status: 'Processing',
    courier: null,
    tracking_number: null,
    ordered_ago_ms: 3 * HOUR,
    delivered_ago_ms: null,
    notes: 'Ordered 3 hours ago. Eligible for cancellation',
  },
];

// Each call gets its own copy, so cancelling ORD-103 in one evaluator's call
// doesn't break the demo for the next person.
export function createOrderStore() {
  const now = Date.now();
  const store = new Map();
  for (const seed of SEED_ORDERS) {
    store.set(seed.order_id, {
      ...seed,
      ordered_at: new Date(now - seed.ordered_ago_ms),
      delivered_at: seed.delivered_ago_ms == null ? null : new Date(now - seed.delivered_ago_ms),
    });
  }
  return store;
}

// Public view for the "Test Orders" helper panel.
export function listSeedOrders() {
  return SEED_ORDERS.map(({ order_id, customer_name, product, value_inr, status, notes }) => ({
    order_id,
    customer_name,
    product,
    value_inr,
    status,
    notes,
  }));
}

const DIGIT_WORDS = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

// Speech-to-text rarely produces a clean "ORD-101". Accept things like
// "ord 101", "order number 101", "O R D one zero one", "101".
export function normalizeOrderId(raw) {
  if (typeof raw !== 'string') return null;
  const words = raw
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    // drop the prefix first, otherwise the "o" in a spelled-out "O R D" reads as zero
    .replace(/\b(order|ord|o r d|number|no|id)\b/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => DIGIT_WORDS[w] ?? w);
  const digits = (words.join(' ').match(/\d+/g) ?? []).join('');
  // A lone "one" in "the blue one" is not an order number.
  if (digits.length < 2) return null;
  return `ORD-${digits}`;
}

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / DAY);
}

// What the model sees for an order. Only facts from the database — no
// invented dates or refund timelines.
export function describeOrder(order, now = new Date()) {
  const view = {
    order_id: order.order_id,
    customer_name: order.customer_name,
    product: order.product,
    order_value: `₹${order.value_inr}`,
    status: order.status,
    courier: order.courier,
    tracking_number: order.tracking_number,
    notes: order.notes,
  };
  if (order.delivered_at) {
    view.days_since_delivery = daysBetween(order.delivered_at, now);
  }
  if (order.status === 'Processing' || order.status === 'Cancelled') {
    view.hours_since_order = Math.round((now - order.ordered_at) / HOUR);
  }
  return view;
}

export { DAY, HOUR, daysBetween };
