'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../../config');
const { validateBody } = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/requireAuth');
const { registerSchema, loginSchema, refreshSchema } = require('./auth.schemas');
const authService = require('./auth.service');

const router = express.Router();

// Brute-force protection on credential endpoints (per IP).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.auth.rateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } },
});

function meta(req) {
  return { userAgent: (req.get('user-agent') || '').slice(0, 300) };
}

router.post('/register', authLimiter, validateBody(registerSchema), async (req, res) => {
  const result = await authService.register({ ...req.body, ...meta(req) });
  res.status(201).json(result);
});

router.post('/login', authLimiter, validateBody(loginSchema), async (req, res) => {
  const result = await authService.login({ ...req.body, ...meta(req) });
  res.json(result);
});

router.post('/refresh', authLimiter, validateBody(refreshSchema), async (req, res) => {
  const result = await authService.refresh(req.body);
  res.json(result);
});

router.post('/logout', requireAuth, async (req, res) => {
  await authService.logout(req.auth.sessionId);
  res.status(204).end();
});

router.post('/logout-all', requireAuth, async (req, res) => {
  await authService.logoutAll(req.auth.userId);
  res.status(204).end();
});

module.exports = router;
