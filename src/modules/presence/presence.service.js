'use strict';

const { Friendship, UserSettings, User } = require('../../database/models');
const registry = require('../../websocket/registry');
const logger = require('../../utils/logger');

async function friendIdsOf(userId) {
  const rows = await Friendship.find({
    status: 'accepted',
    $or: [{ requester: userId }, { recipient: userId }],
  })
    .select('requester recipient')
    .lean();
  return rows.map((r) => (String(r.requester) === String(userId) ? String(r.recipient) : String(r.requester)));
}

/** Users who turned "show online status" off. */
async function hiddenUserIds(ids) {
  if (!ids.length) return new Set();
  const rows = await UserSettings.find({ userId: { $in: ids }, 'preferences.showOnlineStatus': false })
    .select('userId')
    .lean();
  return new Set(rows.map((r) => String(r.userId)));
}

/** { userId: boolean }. Users who hide their status always appear offline. */
async function onlineMap(ids) {
  const hidden = await hiddenUserIds(ids);
  const map = {};
  for (const id of ids) map[id] = registry.isOnline(id) && !hidden.has(id);
  return map;
}

/** Tells all friends of userId that userId is now online/offline. Never throws. */
async function publish(userId, online) {
  try {
    const friends = await friendIdsOf(userId);
    for (const friendId of friends) registry.sendToUser(friendId, 'presence.update', { userId, online });
  } catch (err) {
    logger.warn({ reason: err.message }, 'presence publish failed');
  }
}

async function onConnected(userId) {
  try {
    const hidden = await hiddenUserIds([userId]);
    if (!hidden.has(userId)) await publish(userId, true);
  } catch (err) {
    logger.warn({ reason: err.message }, 'presence onConnected failed');
  }
}

async function onDisconnected(userId) {
  try {
    await User.updateOne({ _id: userId }, { $set: { lastSeenAt: new Date() } });
    const hidden = await hiddenUserIds([userId]);
    if (!hidden.has(userId)) await publish(userId, false);
  } catch (err) {
    logger.warn({ reason: err.message }, 'presence onDisconnected failed');
  }
}

/** Called when a user changes the "show online status" setting. */
async function onVisibilityChanged(userId, visible) {
  await publish(userId, visible && registry.isOnline(userId));
}

module.exports = { friendIdsOf, onlineMap, onConnected, onDisconnected, onVisibilityChanged };
