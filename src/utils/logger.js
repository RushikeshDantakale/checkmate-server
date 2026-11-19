'use strict';

const pino = require('pino');
const config = require('../config');

/**
 * Structured JSON logger. Sensitive fields are redacted so passwords and
 * tokens never reach the logs (Render stores logs).
 */
module.exports = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.secret',
      '*.mongodbUri',
      'password',
      'token',
      'refreshToken',
      'accessToken',
    ],
    censor: '[REDACTED]',
  },
});
