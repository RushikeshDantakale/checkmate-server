'use strict';

const { AppError } = require('../utils/errors');

/**
 * Use after requireAuth. `req.auth.role` is read from the database on every request (see requireAuth),
 * so removing someone's admin role takes effect immediately (D-059).
 */
function requireAdmin(req, res, next) {
  if (!req.auth || req.auth.role !== 'admin') {
    return next(new AppError(403, 'ADMIN_ONLY', 'Administrator access required'));
  }
  return next();
}

module.exports = { requireAdmin };
