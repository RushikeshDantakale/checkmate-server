'use strict';

/**
 * Tiny in-process event bus so modules can react to each other without importing each other.
 * Events used so far:
 *  - 'session.revoked'        { sessionId }
 *  - 'user.sessions.revoked'  { userId }
 * Single-instance only (see D-001); a multi-instance deployment would replace this with Redis pub/sub.
 */
const { EventEmitter } = require('node:events');

module.exports = new EventEmitter();
