'use strict';

const bcrypt = require('bcryptjs');
const config = require('../../config');
const { AppError } = require('../../utils/errors');
const { User, Session } = require('../../database/models');
const { signAccessToken, generateRefreshToken, hashToken } = require('./tokens');
const events = require('../../utils/events');

let dummyHash;
/** Used so a login for an unknown user takes as long as a real one (no user enumeration by timing). */
function getDummyHash() {
  if (!dummyHash) dummyHash = bcrypt.hashSync('not-a-real-password', config.auth.bcryptRounds);
  return dummyHash;
}

function toPublicUser(user) {
  return {
    id: String(user._id),
    email: user.email,
    username: user.username,
    status: user.status,
    role: user.role,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
  };
}

async function issueSession(user, meta) {
  const refreshToken = generateRefreshToken();
  const now = new Date();
  const session = await Session.create({
    userId: user._id,
    refreshTokenHash: hashToken(refreshToken),
    deviceName: meta.deviceName,
    userAgent: meta.userAgent,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + config.auth.refreshTtlMs),
  });
  return {
    user: toPublicUser(user),
    accessToken: signAccessToken({ userId: user._id, sessionId: session._id }),
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: config.auth.accessTtlSeconds,
    sessionId: String(session._id),
  };
}

function accountBlockedError(status) {
  return new AppError(403, `ACCOUNT_${status.toUpperCase()}`, `This account is ${status}`);
}

async function register({ email, username, password, deviceName, userAgent }) {
  const passwordHash = await bcrypt.hash(password, config.auth.bcryptRounds);
  let user;
  try {
    user = await User.create({
      email,
      username,
      usernameLower: username.toLowerCase(),
      passwordHash,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0];
      if (field === 'email') throw new AppError(409, 'EMAIL_TAKEN', 'This email is already registered');
      throw new AppError(409, 'USERNAME_TAKEN', 'This username is already taken');
    }
    throw err;
  }
  return issueSession(user, { deviceName, userAgent });
}

async function login({ identifier, password, deviceName, userAgent }) {
  const query = identifier.includes('@')
    ? { email: identifier.toLowerCase() }
    : { usernameLower: identifier.toLowerCase() };
  const user = await User.findOne(query).select('+passwordHash');
  const passwordOk = await bcrypt.compare(password, user ? user.passwordHash : getDummyHash());
  if (!user || !passwordOk) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username/email or password');
  }
  if (user.status !== 'active') throw accountBlockedError(user.status);
  user.lastLoginAt = new Date();
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: user.lastLoginAt } });
  return issueSession(user, { deviceName, userAgent });
}

async function revokeSession(sessionId, reason) {
  await Session.updateOne(
    { _id: sessionId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  // Lets the WebSocket layer close live connections of this session at once.
  events.emit('session.revoked', { sessionId: String(sessionId) });
}

/**
 * Rotates the refresh token. The old token stops working immediately.
 * If an old (already rotated) token is presented outside the grace window,
 * it is treated as theft and the whole session is revoked.
 */
async function refresh({ refreshToken }) {
  const invalid = () => new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  const oldHash = hashToken(refreshToken);
  const session = await Session.findOne({ refreshTokenHash: oldHash });

  if (!session) {
    const reused = await Session.findOne({ previousRefreshTokenHash: oldHash });
    if (reused && !reused.revokedAt) {
      const age = Date.now() - (reused.lastUsedAt ? reused.lastUsedAt.getTime() : 0);
      if (age >= config.auth.refreshReuseGraceMs) await revokeSession(reused._id, 'refresh_token_reuse');
    }
    throw invalid();
  }
  if (session.revokedAt || session.expiresAt.getTime() <= Date.now()) throw invalid();

  const user = await User.findById(session.userId);
  if (!user) throw invalid();
  if (user.status !== 'active') {
    await revokeSession(session._id, 'account_blocked');
    throw accountBlockedError(user.status);
  }

  const newToken = generateRefreshToken();
  const now = new Date();
  // Atomic: only one concurrent refresh can win; the loser gets INVALID_REFRESH_TOKEN.
  const updated = await Session.findOneAndUpdate(
    { _id: session._id, refreshTokenHash: oldHash, revokedAt: { $exists: false } },
    {
      $set: {
        refreshTokenHash: hashToken(newToken),
        previousRefreshTokenHash: oldHash,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + config.auth.refreshTtlMs),
      },
    },
    { returnDocument: 'after' }
  );
  if (!updated) throw invalid();

  return {
    user: toPublicUser(user),
    accessToken: signAccessToken({ userId: user._id, sessionId: session._id }),
    refreshToken: newToken,
    tokenType: 'Bearer',
    expiresIn: config.auth.accessTtlSeconds,
    sessionId: String(session._id),
  };
}

async function logout(sessionId) {
  await revokeSession(sessionId, 'logout');
}

async function logoutAll(userId) {
  await Session.updateMany(
    { userId, revokedAt: { $exists: false } },
    { $set: { revokedAt: new Date(), revokedReason: 'logout_all' } }
  );
  events.emit('user.sessions.revoked', { userId: String(userId) });
}

module.exports = { register, login, refresh, logout, logoutAll, toPublicUser, revokeSession };
