'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { z } = require('zod');
const events = require('../utils/events');
const registry = require('./registry');
const handlers = require('./handlers');
const { clearExpiryTimers } = require('./handlers/auth.handler');
const { send, sendError } = require('./messaging');
const presence = require('../modules/presence/presence.service');

const PROTOCOL_VERSION = 1;

// Every client message uses this envelope: { id?, type, payload? }.
const envelopeSchema = z.object({
  id: z.string().max(64).optional(),
  type: z.string().min(1).max(64),
  payload: z.unknown().optional(),
});

function createWebSocketServer({ server, config, logger }) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: config.ws.maxPayloadBytes, // oversized frames close the socket with code 1009
  });

  wss.on('connection', (socket) => {
    socket.connectionId = crypto.randomUUID();
    socket.isAlive = true;
    socket.auth = null;
    socket.expiryTimers = [];

    // Unauthenticated sockets may only `auth` and `ping`, and only for a short time.
    socket.authTimer = setTimeout(() => {
      if (!socket.auth) socket.close(4001, 'Authentication timeout');
    }, config.ws.authTimeoutMs);
    socket.authTimer.unref();

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('error', (err) => {
      logger.warn({ connectionId: socket.connectionId, reason: err.message }, 'ws socket error');
    });

    socket.on('close', () => {
      clearTimeout(socket.authTimer);
      clearExpiryTimers(socket);
      const userId = socket.auth && socket.auth.userId;
      const wasRegistered = Boolean(socket.registered);
      if (registry.remove(socket)) {
        presence.onDisconnected(userId);
        // Last device of this user went away: game and matchmaking modules react (grace timers, queue removal).
        events.emit('user.disconnected', { userId });
      }
      // Every authenticated device that goes away (not only the last): voice calls on that device end.
      if (wasRegistered) events.emit('socket.closed', { userId, connectionId: socket.connectionId });
    });

    socket.on('message', async (data, isBinary) => {
      if (isBinary) {
        return socket.close(1003, 'Binary frames are not supported');
      }
      let json;
      try {
        json = JSON.parse(data.toString('utf8'));
      } catch {
        return sendError(socket, 'INVALID_JSON', 'Message is not valid JSON');
      }
      const parsed = envelopeSchema.safeParse(json);
      if (!parsed.success) {
        return sendError(socket, 'INVALID_MESSAGE', 'Message must be { id?, type, payload? }');
      }
      const { id, type, payload } = parsed.data;
      const entry = Object.hasOwn(handlers, type) ? handlers[type] : null;
      if (!entry) {
        return sendError(socket, 'UNKNOWN_EVENT', `Unknown event type: ${type}`, id);
      }
      if (entry.requireAuth) {
        if (!socket.auth) return sendError(socket, 'UNAUTHENTICATED', 'Send auth first', id);
        if (Date.now() >= socket.auth.expiresAtMs) {
          return sendError(socket, 'TOKEN_EXPIRED', 'Access token expired; refresh and send auth again', id);
        }
      }
      try {
        await entry.handle({ socket, payload, id, config, logger });
      } catch (err) {
        logger.error({ connectionId: socket.connectionId, reason: err.message }, 'ws handler failed');
        sendError(socket, 'INTERNAL_ERROR', 'Something went wrong', id);
      }
      return undefined;
    });

    send(socket, 'server.hello', {
      protocol: PROTOCOL_VERSION,
      connectionId: socket.connectionId,
      heartbeatMs: config.ws.heartbeatIntervalMs,
      authTimeoutMs: config.ws.authTimeoutMs,
      serverTime: Date.now(),
    });
  });

  // Logging out (or banning) closes the live sockets of that session/user at once.
  const onSessionRevoked = ({ sessionId }) => registry.closeSession(sessionId, 4004, 'Session revoked');
  const onUserSessionsRevoked = ({ userId }) => registry.closeUser(userId, 4004, 'Session revoked');
  events.on('session.revoked', onSessionRevoked);
  events.on('user.sessions.revoked', onUserSessionsRevoked);

  // Protocol-level heartbeat: a socket that did not answer the previous ping is
  // half-open ("connected but unresponsive") and is terminated.
  const interval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, config.ws.heartbeatIntervalMs);
  interval.unref();

  wss.on('close', () => {
    clearInterval(interval);
    events.off('session.revoked', onSessionRevoked);
    events.off('user.sessions.revoked', onUserSessionsRevoked);
  });

  return wss;
}

module.exports = { createWebSocketServer, PROTOCOL_VERSION };
