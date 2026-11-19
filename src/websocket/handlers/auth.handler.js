'use strict';

const { z } = require('zod');
const { authenticateToken } = require('../../middleware/requireAuth');
const { AppError } = require('../../utils/errors');
const registry = require('../registry');
const events = require('../../utils/events');
const presence = require('../../modules/presence/presence.service');
const { send, sendError } = require('../messaging');

const payloadSchema = z.object({ accessToken: z.string().min(10).max(4096) });

function clearExpiryTimers(socket) {
  for (const timer of socket.expiryTimers || []) clearTimeout(timer);
  socket.expiryTimers = [];
}

/**
 * Token expiry during a live session:
 *  - tokenWarningMs before expiry the server sends `auth.expiring`; the client refreshes
 *    its token over REST and sends `auth` again on the SAME socket.
 *  - After expiry, authenticated events are answered with TOKEN_EXPIRED.
 *  - reauthGraceMs after expiry the socket is closed with code 4002.
 */
function scheduleExpiry(socket, config) {
  clearExpiryTimers(socket);
  const now = Date.now();
  const exp = socket.auth.expiresAtMs;
  const warnIn = Math.max(0, exp - now - config.ws.tokenWarningMs);
  const closeIn = Math.max(0, exp - now) + config.ws.reauthGraceMs;
  const warn = setTimeout(() => {
    send(socket, 'auth.expiring', { expiresAt: new Date(exp).toISOString() });
  }, warnIn);
  const close = setTimeout(() => socket.close(4002, 'Token expired'), closeIn);
  warn.unref();
  close.unref();
  socket.expiryTimers = [warn, close];
}

async function handle({ socket, payload, id, config }) {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return sendError(socket, 'INVALID_PAYLOAD', 'auth needs { accessToken }', id);

  let auth;
  try {
    auth = await authenticateToken(parsed.data.accessToken);
  } catch (err) {
    const known = err instanceof AppError;
    sendError(socket, known ? err.code : 'UNAUTHENTICATED', known ? err.message : 'Authentication failed', id);
    if (!socket.auth) socket.close(4003, 'Authentication failed');
    return undefined;
  }
  if (socket.readyState !== socket.OPEN) return undefined;

  if (socket.auth && (socket.auth.userId !== auth.userId || socket.auth.sessionId !== auth.sessionId)) {
    return sendError(socket, 'AUTH_MISMATCH', 'Re-authentication must use the same user and session', id);
  }

  const first = !socket.auth;
  socket.auth = auth;
  clearTimeout(socket.authTimer);
  scheduleExpiry(socket, config);
  if (first && registry.add(socket)) {
    presence.onConnected(auth.userId);
    events.emit('user.connected', { userId: auth.userId });
  }

  return send(
    socket,
    'auth.ok',
    { userId: auth.userId, sessionId: auth.sessionId, expiresAt: new Date(auth.expiresAtMs).toISOString() },
    id
  );
}

module.exports = { handle, clearExpiryTimers };
