'use strict';

const { AppError } = require('../utils/errors');

/** Validates req.body against a Zod schema and replaces it with the cleaned result. */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return next(new AppError(400, 'VALIDATION_ERROR', message));
    }
    req.body = result.data;
    return next();
  };
}

/** Parses req.query with a Zod schema (req.query is read-only in Express 5, so the result is returned). */
function parseQuery(schema, req) {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join('.') || 'query'}: ${i.message}`)
      .join('; ');
    throw new AppError(400, 'VALIDATION_ERROR', message);
  }
  return result.data;
}

module.exports = { validateBody, parseQuery };
