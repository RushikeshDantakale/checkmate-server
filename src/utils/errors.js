'use strict';

/**
 * Error with an HTTP status and a stable machine-readable code that the
 * Android client can switch on.
 */
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

module.exports = { AppError };
