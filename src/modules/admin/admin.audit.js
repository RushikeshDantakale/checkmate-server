'use strict';

/**
 * Audit-first execution of an admin action (D-059).
 *  1. write the audit row (`started`); if that fails the action is NOT performed (503, retry);
 *  2. run the action;
 *  3. mark the row `done`, or `failed` with the error code, and pass the result or error on.
 * With a `key`, a retry of the same request reuses the same row (the action itself must be idempotent).
 */
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const { AdminAction } = require('../../database/models');

async function finishRow(id, fields) {
  try {
    await AdminAction.updateOne({ _id: id }, { $set: { ...fields, finishedAt: new Date() } });
  } catch (err) {
    // The action already happened; the row stays `started`, which is visible in the log.
    logger.error({ reason: err.message, auditId: String(id) }, 'could not finish an audit row');
  }
}

async function audited({ adminId, action, targetType, targetId = null, details = {}, key }, fn) {
  const row = await withDb(async () => {
    try {
      return (await AdminAction.create({ key, adminId, action, targetType, targetId, details })).toObject();
    } catch (err) {
      if (!(err && err.code === 11000 && key)) throw err;
      const existing = await AdminAction.findOne({ key }).lean();
      const sameRequest =
        existing &&
        String(existing.adminId) === String(adminId) &&
        existing.action === action &&
        String(existing.targetId) === String(targetId);
      if (!sameRequest) throw new AppError(409, 'REQUEST_ID_CONFLICT', 'This requestId was already used for another action');
      return existing;
    }
  }, 'admin audit log');

  try {
    const result = await fn();
    await finishRow(row._id, { status: 'done', errorCode: undefined });
    return result;
  } catch (err) {
    await finishRow(row._id, { status: 'failed', errorCode: String(err && err.code ? err.code : 'INTERNAL_ERROR').slice(0, 60) });
    throw err;
  }
}

module.exports = { audited };
