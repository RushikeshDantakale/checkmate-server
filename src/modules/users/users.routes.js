'use strict';

const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../../middleware/requireAuth');
const { validateBody, parseQuery } = require('../../middleware/validate');
const { requireObjectId } = require('../../utils/objectId');
const users = require('./users.service');
const { profilePatchSchema, settingsPatchSchema } = require('./settings');

const router = express.Router();
router.use(requireAuth);

const searchQuery = z.object({ q: z.string().trim().regex(/^[A-Za-z0-9_]{2,20}$/, '2-20 letters, numbers or underscores') });

router.get('/me', async (req, res) => {
  res.json({ user: await users.getMe(req.auth.userId) });
});

router.patch('/me', validateBody(profilePatchSchema), async (req, res) => {
  res.json({ user: await users.updateProfile(req.auth.userId, req.body) });
});

router.get('/me/settings', async (req, res) => {
  res.json({ settings: await users.getSettings(req.auth.userId) });
});

router.patch('/me/settings', validateBody(settingsPatchSchema), async (req, res) => {
  res.json({ settings: await users.updateSettings(req.auth.userId, req.body) });
});

router.get('/search', async (req, res) => {
  res.json(await users.searchUsers(req.auth.userId, parseQuery(searchQuery, req).q));
});

router.get('/:id', async (req, res) => {
  const id = requireObjectId(req.params.id, 'user id');
  res.json({ user: await users.getPublicProfile(req.auth.userId, id) });
});

module.exports = router;
