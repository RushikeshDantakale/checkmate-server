'use strict';

const config = require('../../../config');
const disabled = require('./disabled');
const fake = require('./fake');
const { createGoogleVerifier } = require('./google');

let override = null;
let google = null;

/**
 * The verifier chosen by PURCHASE_VERIFIER (D-050). The rest of the app only sees
 * { name, verify, finalize } and never mentions a provider.
 */
function current() {
  if (override) return override;
  switch (config.purchases.verifier) {
    case 'fake':
      return fake;
    case 'google':
      if (!google) {
        google = createGoogleVerifier({
          packageName: config.purchases.googlePackageName,
          serviceAccountJson: config.purchases.googleServiceAccountJson,
        });
      }
      return google;
    default:
      return disabled;
  }
}

/** Tests only: force a verifier (pass null to go back to the configured one). */
function setVerifierForTests(verifier) {
  override = verifier;
}

module.exports = { current, setVerifierForTests };
