'use strict';

const crypto = require('node:crypto');
const config = require('../config');

/**
 * ICE servers for WebRTC (D-027). The rest of the app never mentions a provider.
 *  - STUN always (ICE_STUN_URLS).
 *  - TURN only if TURN_URLS is set, with one of two credential styles:
 *      static  TURN_USERNAME + TURN_CREDENTIAL (Metered, or any provider that hands out fixed credentials)
 *      secret  TURN_SECRET: per-user, time-limited credentials (coturn "use-auth-secret" / REST API style)
 * Audio never passes through this server: TURN is a separate relay run by the provider.
 */
function turnAvailable() {
  return config.voice.turnUrls.length > 0;
}

function turnEntry(userId, nowMs) {
  const { turnUrls, turnUsername, turnCredential, turnSecret, turnCredentialTtlSeconds } = config.voice;
  if (turnSecret) {
    const expiresAt = Math.floor(nowMs / 1000) + turnCredentialTtlSeconds;
    const username = `${expiresAt}:${userId}`;
    const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
    return { urls: turnUrls, username, credential };
  }
  return { urls: turnUrls, username: turnUsername, credential: turnCredential };
}

/** Returns what the client needs to build its RTCPeerConnection configuration. */
function getIceConfig(userId, nowMs = Date.now()) {
  const iceServers = [];
  if (config.voice.stunUrls.length) iceServers.push({ urls: config.voice.stunUrls });
  if (turnAvailable()) iceServers.push(turnEntry(String(userId), nowMs));
  return {
    iceServers,
    turnAvailable: turnAvailable(),
    ttlSeconds: config.voice.turnSecret ? config.voice.turnCredentialTtlSeconds : null,
  };
}

module.exports = { getIceConfig, turnAvailable };
