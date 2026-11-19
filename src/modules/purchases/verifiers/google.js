'use strict';

/**
 * Google Play verifier (D-050), written against the documented Google Play Developer API v3
 * (purchases.products: get, acknowledge, consume) with a service account.
 *
 * !!! NOT verified against real Google. It has only been tested with a stubbed HTTP layer
 * (tests/purchases.test.js). It needs a Play Console account, a linked service account with
 * "view financial data" and "manage orders" permission, and real products. Before relying on it,
 * make a test purchase with a licence-tester account and watch the server log.
 *
 * Uses Node's built-in crypto and fetch, so no extra package is needed.
 */
const crypto = require('node:crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const enc = encodeURIComponent;

function createGoogleVerifier({ packageName, serviceAccountJson, fetchImpl = fetch, now = Date.now }) {
  const key = JSON.parse(serviceAccountJson);
  let cached = null; // { token, expiresAtMs }

  async function accessToken() {
    if (cached && cached.expiresAtMs - 60000 > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const header = b64url({ alg: 'RS256', typ: 'JWT' });
    const claim = b64url({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 });
    const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key.private_key, 'base64url');
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claim}.${signature}`,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Google token request failed (${res.status})`);
    const json = await res.json();
    cached = { token: json.access_token, expiresAtMs: now() + Number(json.expires_in || 3600) * 1000 };
    return cached.token;
  }

  async function request(method, url, body) {
    const token = await accessToken();
    return fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const productUrl = (productId, purchaseToken) =>
    `${API}/${enc(packageName)}/purchases/products/${enc(productId)}/tokens/${enc(purchaseToken)}`;

  async function fetchPurchase(productId, purchaseToken) {
    const res = await request('GET', productUrl(productId, purchaseToken));
    // Google answers 400/404/410 for a token that does not exist for this product.
    if (res.status === 400 || res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new Error(`Google purchase lookup failed (${res.status})`);
    return res.json();
  }

  return {
    name: 'google',

    async verify({ productId, purchaseToken }) {
      const p = await fetchPurchase(productId, purchaseToken);
      if (!p) return { status: 'invalid' };
      const base = { orderId: p.orderId, accountId: p.obfuscatedExternalAccountId };
      if (p.purchaseState === 0) return { status: 'purchased', ...base };
      if (p.purchaseState === 2) return { status: 'pending', ...base };
      return { status: 'cancelled', ...base }; // 1 = cancelled or refunded
    },

    /** Consumables are consumed (so they can be bought again), everything else is acknowledged. */
    async finalize({ productId, purchaseToken, consumable }) {
      const p = await fetchPurchase(productId, purchaseToken);
      if (!p) throw new Error('purchase not found at finalize');
      if (consumable && p.consumptionState === 1) return; // already done, nothing to do
      if (!consumable && p.acknowledgementState === 1) return;
      const action = consumable ? 'consume' : 'acknowledge';
      const res = await request('POST', `${productUrl(productId, purchaseToken)}:${action}`, consumable ? undefined : {});
      if (!res.ok) throw new Error(`Google ${action} failed (${res.status})`);
    },
  };
}

module.exports = { createGoogleVerifier };
