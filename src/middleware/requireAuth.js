'use strict';

const { AppError } = require('../utils/errors');
const { User, Session } = require('../database/models');
const { verifyAccessToken } = require('../modules/auth/tokens');

/**
 * Verifies the access token AND checks the database, so logging out, banning
 * a user or revoking a session takes effect immediately (not after token expiry).
 * Sets req.auth = { userId, sessionId, role }.
 */
async function authenticateToken(token) {
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new AppError(401, 'TOKEN_EXPIRED', 'Access token expired');
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid access token');
  }
  const session = await Session.findById(claims.sid).select('userId revokedAt expiresAt');
  if (
    !session ||
    String(session.userId) !== claims.sub ||
    session.revokedAt ||
    session.expiresAt.getTime() <= Date.now()
  ) {
    throw new AppError(401, 'SESSION_REVOKED', 'Session is no longer valid');
  }
  const user = await User.findById(claims.sub).select('status role');
  if (!user) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid access token');
  if (user.status !== 'active') {
    throw new AppError(403, `ACCOUNT_${user.status.toUpperCase()}`, `This account is ${user.status}`);
  }
  return {
    userId: String(user._id),
    sessionId: String(session._id),
    role: user.role,
    expiresAtMs: claims.exp * 1000,
  };
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Missing bearer token'));
  }
  try {
    req.auth = await authenticateToken(token);
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth, authenticateToken };
