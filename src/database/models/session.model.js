'use strict';

const mongoose = require('mongoose');

/**
 * One document per logged-in device. The refresh token itself is never stored,
 * only its SHA-256 hash. `previousRefreshTokenHash` enables reuse detection
 * after rotation.
 */
const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    refreshTokenHash: { type: String, required: true, unique: true },
    previousRefreshTokenHash: { type: String, index: true },
    deviceName: { type: String, maxlength: 100 },
    userAgent: { type: String, maxlength: 300 },
    lastUsedAt: { type: Date },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    revokedReason: { type: String, maxlength: 50 },
  },
  { timestamps: true }
);

// MongoDB deletes a session 30 days AFTER it expired (retention policy, D-060). The server itself
// already refuses expired and revoked sessions, so these 30 days only keep a short trail.
const SESSION_RETENTION_AFTER_EXPIRY_SECONDS = 30 * 24 * 60 * 60;
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: SESSION_RETENTION_AFTER_EXPIRY_SECONDS });

const Session = mongoose.model('Session', sessionSchema);
Session.RETENTION_AFTER_EXPIRY_SECONDS = SESSION_RETENTION_AFTER_EXPIRY_SECONDS;

module.exports = Session;
