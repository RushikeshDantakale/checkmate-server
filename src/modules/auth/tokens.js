'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');

const ISSUER = 'checkmate-server';

/** Short-lived access token. Carries the session id so logout revokes it at once. */
function signAccessToken({ userId, sessionId }) {
  return jwt.sign({ sid: String(sessionId) }, config.auth.accessSecret, {
    algorithm: 'HS256',
    issuer: ISSUER,
    subject: String(userId),
    expiresIn: config.auth.accessTtlSeconds,
  });
}

/** Throws a jsonwebtoken error (TokenExpiredError / JsonWebTokenError) if invalid. */
function verifyAccessToken(token) {
  return jwt.verify(token, config.auth.accessSecret, { algorithms: ['HS256'], issuer: ISSUER });
}

/** Opaque random refresh token (not a JWT). */
function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

/** Refresh tokens are high-entropy, so a fast hash is sufficient for storage. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { signAccessToken, verifyAccessToken, generateRefreshToken, hashToken };
