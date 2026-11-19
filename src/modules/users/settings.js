'use strict';

const { z } = require('zod');

const DEFAULT_SETTINGS = Object.freeze({
  boardTheme: 'classic',
  pieceSet: 'standard',
  soundEnabled: true,
  premove: true,
  autoQueen: false,
  showOnlineStatus: true,
  friendRequestsFrom: 'everyone',
  language: 'en',
});

// Partial update: unknown keys are rejected.
const settingsPatchSchema = z
  .object({
    boardTheme: z.string().trim().min(1).max(30),
    pieceSet: z.string().trim().min(1).max(30),
    soundEnabled: z.boolean(),
    premove: z.boolean(),
    autoQueen: z.boolean(),
    showOnlineStatus: z.boolean(),
    friendRequestsFrom: z.enum(['everyone', 'nobody']),
    language: z.string().trim().min(2).max(10),
  })
  .partial()
  .strict();

const profilePatchSchema = z
  .object({
    displayName: z.string().trim().max(30).nullable(),
    bio: z.string().trim().max(160).nullable(),
    avatarId: z.string().trim().max(50).nullable(),
  })
  .partial()
  .strict();

module.exports = { DEFAULT_SETTINGS, settingsPatchSchema, profilePatchSchema };
