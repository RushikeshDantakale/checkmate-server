'use strict';

/**
 * Last-resort protection for the Node.js process (D-057).
 *
 * - uncaughtException: the process state can no longer be trusted. Log it, then exit with code 1 so
 *   Render restarts the server. Games survive because every accepted move is already in MongoDB
 *   and boot recovery pauses live games with their last clock snapshot (D-012).
 * - unhandledRejection: usually a forgotten catch in a timer or a handler. One of these must not
 *   kill every live game, so it is logged and counted. Too many in a short window means something
 *   is badly wrong and the process exits like above.
 *
 * Nothing here logs the error's message from user input beyond `err.message` and the stack, and the
 * logger already redacts tokens and passwords.
 */

const DEFAULTS = {
  maxRejections: 5, // unhandled rejections tolerated ...
  windowMs: 60000, // ... inside this window
  exitDelayMs: 500, // time to flush the log before exiting
};

/**
 * Installs the handlers.
 * @param {object} deps
 * @param {object} deps.logger pino-style logger
 * @param {NodeJS.EventEmitter} [deps.proc] the process (injectable for tests)
 * @param {(code:number)=>void} [deps.exit] exit function (injectable for tests)
 * @param {() => number} [deps.now] clock (injectable for tests)
 * @param {object} [deps.options] overrides for DEFAULTS
 * @returns {{ uninstall: () => void, rejectionCount: () => number }}
 */
function installProcessGuards({ logger, proc = process, exit = process.exit, now = Date.now, options = {} }) {
  const opts = { ...DEFAULTS, ...options };
  let rejectionTimes = [];
  let exiting = false;

  function fatalExit(reason, err) {
    if (exiting) return;
    exiting = true;
    logger.fatal({ reason, err: describe(err) }, 'fatal process error, exiting so the host restarts the server');
    const timer = setTimeout(() => exit(1), opts.exitDelayMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function onUncaughtException(err) {
    fatalExit('uncaughtException', err);
  }

  function onUnhandledRejection(err) {
    const t = now();
    rejectionTimes = rejectionTimes.filter((x) => t - x < opts.windowMs);
    rejectionTimes.push(t);
    logger.error({ err: describe(err), inWindow: rejectionTimes.length }, 'unhandled promise rejection');
    if (rejectionTimes.length > opts.maxRejections) fatalExit('too many unhandled rejections', err);
  }

  proc.on('uncaughtException', onUncaughtException);
  proc.on('unhandledRejection', onUnhandledRejection);

  return {
    uninstall() {
      proc.removeListener('uncaughtException', onUncaughtException);
      proc.removeListener('unhandledRejection', onUnhandledRejection);
    },
    rejectionCount: () => rejectionTimes.length,
  };
}

function describe(err) {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { value: String(err) };
}

module.exports = { installProcessGuards };
