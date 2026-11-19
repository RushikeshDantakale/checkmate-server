'use strict';

/**
 * Notifications (D-051): stored in MongoDB (30 days) and pushed live to every connected device.
 *
 *  - Other modules call `notify()` (never throws: a failed notification must not break a payout or
 *    a game) or `create()` (throws, used by tests and callers that care).
 *  - Pass a `key` when the same event may be reported twice (a retry, a sweeper that runs again after
 *    a crash): the second call returns the stored notification with `duplicate: true` and pushes nothing.
 *  - A user who is offline simply finds the notifications when the app next opens (REST).
 *    Phone push while the app is closed (Firebase) is NOT included: it needs a Firebase project (D-051).
 */
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const registry = require('../../websocket/registry');
const { Notification } = require('../../database/models');

const MAX_DATA_BYTES = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

function view(n) {
  return {
    id: String(n._id),
    type: n.type,
    data: n.data || {},
    readAt: n.readAt || null,
    createdAt: n.createdAt,
  };
}

const countUnread = (userId) => Notification.countDocuments({ userId, readAt: null });

/** Stores a notification and pushes it live. Throws on a database failure. */
async function create({ userId, type, data = {}, key, now = Date.now() }) {
  if (!Notification.TYPES.includes(type)) throw new TypeError(`unknown notification type: ${type}`);
  if (JSON.stringify(data).length > MAX_DATA_BYTES) throw new TypeError('notification data is too large');

  return withDb(async () => {
    let doc;
    let duplicate = false;
    try {
      const created = await Notification.create({
        userId,
        type,
        data,
        key,
        expireAt: new Date(now + Notification.RETENTION_DAYS * DAY_MS),
      });
      doc = created.toObject();
    } catch (err) {
      if (!(key && err && err.code === 11000)) throw err;
      doc = await Notification.findOne({ userId, key }).lean();
      if (!doc) throw err;
      duplicate = true;
    }
    if (!duplicate) {
      registry.sendToUser(userId, 'notification.new', { notification: view(doc), unread: await countUnread(userId) });
    }
    return { notification: view(doc), duplicate };
  }, 'create notification');
}

/** Same as create(), but never throws: returns null (and logs) if the notification could not be stored. */
async function notify(args) {
  try {
    return await create(args);
  } catch (err) {
    logger.warn({ reason: err.message, type: args && args.type }, 'could not create notification');
    return null;
  }
}

async function list(userId, { limit, cursor, unreadOnly }) {
  return withDb(async () => {
    const filter = { userId };
    if (unreadOnly) filter.readAt = null;
    if (cursor) filter._id = { $lt: cursor };
    const rows = await Notification.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map(view),
      nextCursor: hasMore ? String(page[page.length - 1]._id) : null,
      unread: await countUnread(userId),
    };
  }, 'list notifications');
}

async function unreadCount(userId) {
  return withDb(async () => ({ unread: await countUnread(userId) }), 'count notifications');
}

/** Idempotent. Someone else's notification and an unknown id both answer 404. */
async function markRead(userId, id) {
  return withDb(async () => {
    const updated = await Notification.findOneAndUpdate(
      { _id: id, userId, readAt: null },
      { $set: { readAt: new Date() } },
      { returnDocument: 'after' }
    ).lean();
    let readAt;
    if (updated) {
      readAt = updated.readAt;
    } else {
      const existing = await Notification.findOne({ _id: id, userId }).select('readAt').lean();
      if (!existing) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
      readAt = existing.readAt;
    }
    const unread = await countUnread(userId);
    // The user's other devices clear their badge.
    if (updated) registry.sendToUser(userId, 'notification.read', { ids: [String(id)], unread });
    return { id: String(id), readAt, unread };
  }, 'mark notification read');
}

async function markAllRead(userId) {
  return withDb(async () => {
    const res = await Notification.updateMany({ userId, readAt: null }, { $set: { readAt: new Date() } });
    const unread = await countUnread(userId);
    if (res.modifiedCount > 0) registry.sendToUser(userId, 'notification.read', { all: true, unread });
    return { markedRead: res.modifiedCount, unread };
  }, 'mark all notifications read');
}

module.exports = { create, notify, list, unreadCount, markRead, markAllRead };
