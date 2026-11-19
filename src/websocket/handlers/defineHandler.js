'use strict';

const { AppError } = require('../../utils/errors');
const { sendError } = require('../messaging');
const { consume } = require('../rateLimiter');

/**
 * Wraps a WebSocket event: validates the payload with a Zod schema and turns AppError into
 * a protocol error reply `{ type: 'error', id, payload: { code, message } }`.
 * Anything else is rethrown and becomes INTERNAL_ERROR in the server loop.
 *
 * options.rateLimit = { key, limit, windowMs } applies a per-socket token bucket (D-030) BEFORE
 * the payload is parsed, so spam is dropped cheaply. Exceeding it answers RATE_LIMITED.
 */
function defineHandler(schema, fn, options = {}) {
  const { rateLimit } = options;
  return async (ctx) => {
    const { socket, payload, id } = ctx;
    if (rateLimit && !consume(socket, rateLimit.key, rateLimit.limit, rateLimit.windowMs)) {
      return sendError(socket, 'RATE_LIMITED', 'Too many messages; slow down', id);
    }
    const parsed = schema.safeParse(payload === undefined ? {} : payload);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`).join('; ');
      return sendError(socket, 'INVALID_PAYLOAD', message, id);
    }
    try {
      return await fn({ ...ctx, data: parsed.data, userId: socket.auth.userId });
    } catch (err) {
      if (err instanceof AppError) return sendError(socket, err.code, err.message, id);
      throw err;
    }
  };
}

module.exports = { defineHandler };
