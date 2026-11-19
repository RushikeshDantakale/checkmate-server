'use strict';

const { z } = require('zod');

const email = z.string().trim().toLowerCase().max(254).email();
// bcrypt only uses the first 72 bytes, so longer passwords are rejected instead of silently truncated.
const password = z.string().min(8).max(72);
const username = z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/, '3-20 letters, numbers or underscores');
const deviceName = z.string().trim().max(100).optional();

const registerSchema = z.object({ email, username, password, deviceName });

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254), // email or username
  password: z.string().min(1).max(72),
  deviceName,
});

const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

module.exports = { registerSchema, loginSchema, refreshSchema };
