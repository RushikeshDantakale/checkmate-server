'use strict';

const { User, UserSettings } = require('../../database/models');
const { AppError } = require('../../utils/errors');
const { toPublicUser } = require('../auth/auth.service');
const friends = require('../friends/friends.service');
const presence = require('../presence/presence.service');
const { DEFAULT_SETTINGS } = require('./settings');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ownUser(user) {
  return {
    ...toPublicUser(user),
    displayName: user.displayName || null,
    bio: user.bio || null,
    avatarId: user.avatarId || null,
  };
}

async function getMe(userId) {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  return ownUser(user);
}

async function updateProfile(userId, patch) {
  const $set = {};
  const $unset = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') $unset[key] = '';
    else $set[key] = value;
  }
  const update = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  if (Object.keys(update).length) await User.updateOne({ _id: userId }, update);
  return getMe(userId);
}

async function getPublicProfile(viewerId, targetId) {
  const user = await User.findById(targetId);
  if (!user || user.status !== 'active') throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  if (String(user._id) !== viewerId && (await friends.isBlockedEitherWay(viewerId, targetId))) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }
  const online = (await presence.onlineMap([targetId]))[targetId];
  return {
    id: String(user._id),
    username: user.username,
    displayName: user.displayName || null,
    bio: user.bio || null,
    avatarId: user.avatarId || null,
    createdAt: user.createdAt,
    online,
  };
}

async function searchUsers(viewerId, q) {
  const blocked = await friends.blockedEitherWay(viewerId);
  const rows = await User.find({
    usernameLower: { $regex: `^${escapeRegex(q.toLowerCase())}` },
    status: 'active',
    _id: { $nin: [viewerId, ...blocked] },
  })
    .select('username displayName avatarId')
    .sort({ usernameLower: 1 })
    .limit(10)
    .lean();
  return { items: rows.map(friends.publicUser) };
}

function mergeSettings(doc) {
  const prefs = doc && doc.preferences ? doc.preferences : {};
  const merged = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (prefs[key] !== undefined && prefs[key] !== null) merged[key] = prefs[key];
  }
  return merged;
}

async function getSettings(userId) {
  const doc = await UserSettings.findOne({ userId }).lean();
  return mergeSettings(doc);
}

async function updateSettings(userId, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return getSettings(userId);
  const $set = {};
  for (const key of keys) $set[`preferences.${key}`] = patch[key];
  const doc = await UserSettings.findOneAndUpdate({ userId }, { $set }, {
    upsert: true,
    returnDocument: 'after',
    setDefaultsOnInsert: true,
  }).lean();
  if (patch.showOnlineStatus !== undefined) presence.onVisibilityChanged(userId, patch.showOnlineStatus);
  return mergeSettings(doc);
}

module.exports = { getMe, updateProfile, getPublicProfile, searchUsers, getSettings, updateSettings };
