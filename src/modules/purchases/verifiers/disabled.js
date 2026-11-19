'use strict';

const { AppError } = require('../../../utils/errors');

/** Default verifier (D-050): real-money purchases are switched off until a provider is configured. */
function notConfigured() {
  throw new AppError(503, 'PURCHASES_NOT_CONFIGURED', 'Purchases are not available on this server yet');
}

module.exports = {
  name: 'disabled',
  verify: notConfigured,
  finalize: notConfigured,
};
