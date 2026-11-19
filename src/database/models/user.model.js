'use strict';

const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    username: { type: String, required: true, trim: true, minlength: 3, maxlength: 20 },
    // Lower-cased copy so usernames are unique case-insensitively ("Rushi" == "rushi").
    usernameLower: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['active', 'suspended', 'banned'], default: 'active' },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    // Set by an administrator together with a status change (D-059).
    statusReason: { type: String, maxlength: 300 },
    statusChangedAt: { type: Date },
    statusChangedBy: { type: mongoose.Schema.Types.ObjectId },
    emailVerified: { type: Boolean, default: false },
    // Elo rating (D-022). Users created before Phase 3 have no value; code treats a missing value as 1200.
    rating: { type: Number, default: 1200 },
    lastLoginAt: { type: Date },
    lastSeenAt: { type: Date },
    displayName: { type: String, trim: true, maxlength: 30 },
    bio: { type: String, trim: true, maxlength: 160 },
    avatarId: { type: String, trim: true, maxlength: 50 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
