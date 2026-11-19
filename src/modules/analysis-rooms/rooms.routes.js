'use strict';

const express = require('express');
const { requireAuth } = require('../../middleware/requireAuth');
const { requireObjectId } = require('../../utils/objectId');
const rooms = require('./rooms.service');

const router = express.Router();
router.use(requireAuth);

// Rooms I am a member of or invited to (open and recently closed), most recently active first.
router.get('/', async (req, res) => {
  res.json(await rooms.listRooms(req.auth.userId));
});

// The full state of one room. Anyone who is not a member gets 404, whether or not the room exists.
router.get('/:id', async (req, res) => {
  const id = requireObjectId(req.params.id, 'room id');
  res.json(await rooms.getRoom(req.auth.userId, id));
});

module.exports = router;
