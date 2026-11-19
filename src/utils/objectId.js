'use strict';

const mongoose = require('mongoose');
const { AppError } = require('./errors');

/** Returns the id as a string or throws a 400 if it is not a valid MongoDB ObjectId. */
function requireObjectId(value, label = 'id') {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value) || !mongoose.isValidObjectId(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', `${label} is not a valid id`);
  }
  return value;
}

module.exports = { requireObjectId };
