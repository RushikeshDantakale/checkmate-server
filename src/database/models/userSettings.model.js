'use strict';

const mongoose = require('mongoose');

/** Defaults live here and are mirrored by modules/users/settings.js. */
const userSettingsSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    preferences: {
      boardTheme: { type: String, default: 'classic', maxlength: 30 },
      pieceSet: { type: String, default: 'standard', maxlength: 30 },
      soundEnabled: { type: Boolean, default: true },
      premove: { type: Boolean, default: true },
      autoQueen: { type: Boolean, default: false },
      showOnlineStatus: { type: Boolean, default: true },
      friendRequestsFrom: { type: String, enum: ['everyone', 'nobody'], default: 'everyone' },
      language: { type: String, default: 'en', maxlength: 10 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UserSettings', userSettingsSchema);
