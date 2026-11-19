'use strict';

const crypto = require('node:crypto');

/**
 * Development and test verifier (D-050). NEVER usable in production (config refuses to start).
 * The purchase token decides the answer, so tests and a developer can try every path:
 *   fake-valid-...        purchased
 *   fake-pending-...      payment still pending
 *   fake-cancelled-...    cancelled / refunded
 *   fake-otheraccount-... purchased, but made for a different account
 *   anything else         invalid
 * `failFinalize = true` makes acknowledge/consume fail, to test recovery. `calls` records what happened.
 */
const fake = {
  name: 'fake',
  calls: [],
  failFinalize: false,

  reset() {
    this.calls.length = 0;
    this.failFinalize = false;
  },

  async verify({ productId, purchaseToken }) {
    this.calls.push({ op: 'verify', productId });
    const orderId = `FAKE.${crypto.createHash('sha256').update(purchaseToken).digest('hex').slice(0, 12)}`;
    if (purchaseToken.startsWith('fake-valid-')) return { status: 'purchased', orderId };
    if (purchaseToken.startsWith('fake-otheraccount-')) return { status: 'purchased', orderId, accountId: 'someone-else' };
    if (purchaseToken.startsWith('fake-pending-')) return { status: 'pending', orderId };
    if (purchaseToken.startsWith('fake-cancelled-')) return { status: 'cancelled', orderId };
    return { status: 'invalid' };
  },

  async finalize({ productId, consumable }) {
    this.calls.push({ op: consumable ? 'consume' : 'acknowledge', productId });
    if (this.failFinalize) throw new Error('fake store unavailable');
  },
};

module.exports = fake;
