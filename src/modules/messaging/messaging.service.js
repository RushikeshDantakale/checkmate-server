'use strict';

/**
 * Permanent personal messages between two users (collection personal_messages).
 *
 * Rules (decisions D-028 to D-031):
 *  - Friends only. A stranger or a blocked user gets NOT_FRIENDS (a block is not revealed).
 *    Old history stays readable by both users after an unfriend or block; nothing new can be sent.
 *  - A message is saved FIRST; the conversation summary (last message, unread counters) is updated
 *    afterwards with a conditional update. Not a transaction: after a crash between the two steps
 *    a counter can be briefly stale, a message is never lost or duplicated.
 *  - The client sends a clientMessageId and reuses it when it retries; a unique index
 *    (senderId, clientMessageId) turns a retry into "return the stored message, duplicate: true".
 *  - Messages are plain text; the client must render them as text, never as HTML.
 */
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const registry = require('../../websocket/registry');
const { User, Conversation, PersonalMessage } = require('../../database/models');
const friends = require('../friends/friends.service');

const PREVIEW_LENGTH = 80;

function messageView(m) {
  return {
    id: String(m._id),
    conversationId: String(m.conversationId),
    senderId: String(m.senderId),
    recipientId: String(m.recipientId),
    body: m.body,
    createdAt: m.createdAt,
    readAt: m.readAt || null,
  };
}

function indexOf(conversation, userId) {
  return conversation.members.findIndex((m) => String(m) === String(userId));
}

function otherMember(conversation, userId) {
  return String(conversation.members[indexOf(conversation, userId) === 0 ? 1 : 0]);
}

function conversationView(conversation, userId, user) {
  const last = conversation.lastMessage && conversation.lastMessage.messageId ? conversation.lastMessage : null;
  return {
    id: String(conversation._id),
    user: user ? friends.publicUser(user) : null,
    lastMessage: last
      ? { id: String(last.messageId), senderId: String(last.senderId), preview: last.preview, at: last.at }
      : null,
    unread: conversation.unread[indexOf(conversation, userId)] || 0,
    lastMessageAt: conversation.lastMessageAt || null,
  };
}

async function getOrCreateConversation(a, b, attempt = 0) {
  try {
    return await Conversation.findOneAndUpdate(
      { pairKey: Conversation.makePairKey(a, b) },
      { $setOnInsert: { pairKey: Conversation.makePairKey(a, b), members: Conversation.sortedMembers(a, b), unread: [0, 0] } },
      { upsert: true, returnDocument: 'after' }
    ).lean();
  } catch (err) {
    // Two first messages between the same users at the same moment: the second upsert loses the race.
    if (err && err.code === 11000 && attempt === 0) return getOrCreateConversation(a, b, 1);
    throw err;
  }
}

/**
 * Brings the conversation summary up to date for `message`. Conditional: it only applies if the
 * summary does not yet show this message or a newer one, so a retry never counts a message twice
 * and a retry after a crash repairs a missing update. Returns the conversation as it is now.
 */
async function applySummary(conversation, message) {
  const idx = indexOf(conversation, message.recipientId);
  const updated = await Conversation.findOneAndUpdate(
    {
      _id: conversation._id,
      $or: [{ 'lastMessage.messageId': { $exists: false } }, { 'lastMessage.messageId': { $lt: message._id } }],
    },
    {
      $set: {
        lastMessage: {
          messageId: message._id,
          senderId: message.senderId,
          preview: message.body.slice(0, PREVIEW_LENGTH),
          at: message.createdAt,
        },
        lastMessageAt: message.createdAt,
      },
      $inc: { [`unread.${idx}`]: 1 },
    },
    { returnDocument: 'after' }
  ).lean();
  return updated || Conversation.findById(conversation._id).lean();
}

async function sendMessage(senderId, { toUserId, clientMessageId, body }, fromSocket) {
  if (String(toUserId) === String(senderId)) throw new AppError(400, 'CANNOT_MESSAGE_SELF', 'You cannot message yourself');
  return withDb(async () => {
    // A retry must succeed even if the friendship has changed since the first attempt.
    const existing = await PersonalMessage.findOne({ senderId, clientMessageId }).lean();
    if (existing) {
      if (String(existing.recipientId) !== String(toUserId)) {
        throw new AppError(409, 'DUPLICATE_CLIENT_MESSAGE_ID', 'clientMessageId was already used for another message');
      }
      const conversation = await Conversation.findById(existing.conversationId).lean();
      if (conversation) await applySummary(conversation, existing); // repairs a missing summary update
      return { message: messageView(existing), duplicate: true };
    }

    if (!(await friends.areFriends(senderId, toUserId)) || (await friends.isBlockedEitherWay(senderId, toUserId))) {
      throw new AppError(403, 'NOT_FRIENDS', 'You can only message your friends');
    }

    const conversation = await getOrCreateConversation(senderId, toUserId);
    let message;
    try {
      const doc = await PersonalMessage.create({
        conversationId: conversation._id,
        senderId,
        recipientId: toUserId,
        clientMessageId,
        body,
      });
      message = doc.toObject();
    } catch (err) {
      if (err && err.code === 11000) {
        // The same retry arrived twice at the same moment; the other request won.
        const stored = await PersonalMessage.findOne({ senderId, clientMessageId }).lean();
        if (stored && String(stored.recipientId) === String(toUserId)) {
          return { message: messageView(stored), duplicate: true };
        }
        throw new AppError(409, 'DUPLICATE_CLIENT_MESSAGE_ID', 'clientMessageId was already used for another message');
      }
      throw err;
    }

    // The message is durable. Now the summary, then the live pushes.
    const updated = await applySummary(conversation, message);
    const view = messageView(message);
    const unreadOf = (userId) => (updated ? updated.unread[indexOf(updated, userId)] || 0 : null);
    registry.sendToUser(toUserId, 'message.new', {
      message: view,
      conversation: { id: view.conversationId, unread: unreadOf(toUserId) },
    });
    registry.sendToUser(
      senderId,
      'message.new',
      { message: view, conversation: { id: view.conversationId, unread: unreadOf(senderId) } },
      fromSocket
    );
    return { message: view, duplicate: false };
  }, 'send personal message');
}

/** Cursor = "<lastMessageAt ms>_<conversation id>", opaque to clients. */
function conversationCursor(c) {
  return `${new Date(c.lastMessageAt).getTime()}_${c._id}`;
}

async function listConversations(userId, { limit, cursor }) {
  return withDb(async () => {
    const filter = { members: userId, lastMessageAt: { $type: 'date' } };
    if (cursor) {
      const [ms, id] = cursor.split('_');
      const at = new Date(Number(ms));
      filter.$or = [{ lastMessageAt: { $lt: at } }, { lastMessageAt: at, _id: { $lt: id } }];
    }
    const rows = await Conversation.find(filter).sort({ lastMessageAt: -1, _id: -1 }).limit(limit + 1).lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const users = await User.find({ _id: { $in: page.map((c) => otherMember(c, userId)) } })
      .select('username displayName avatarId')
      .lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    const items = page
      .filter((c) => byId.has(otherMember(c, userId)))
      .map((c) => conversationView(c, userId, byId.get(otherMember(c, userId))));
    return { items, nextCursor: hasMore ? conversationCursor(page[page.length - 1]) : null };
  }, 'list conversations');
}

/** The caller's own conversation with `otherUserId`, or null if they never wrote to each other. */
async function getConversationWith(userId, otherUserId) {
  return withDb(async () => {
    const conversation = await Conversation.findOne({ pairKey: Conversation.makePairKey(userId, otherUserId) }).lean();
    if (!conversation || !conversation.lastMessageAt) return null;
    const user = await User.findById(otherUserId).select('username displayName avatarId').lean();
    return conversationView(conversation, userId, user);
  }, 'get conversation');
}

/** Same answer for "does not exist" and "not yours" (scenario 25). */
async function requireMemberConversation(userId, conversationId) {
  const conversation = await Conversation.findOne({ _id: conversationId, members: userId }).lean();
  if (!conversation) throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
  return conversation;
}

async function listMessages(userId, conversationId, { limit, cursor }) {
  return withDb(async () => {
    await requireMemberConversation(userId, conversationId);
    const filter = { conversationId };
    if (cursor) filter._id = { $lt: cursor };
    const rows = await PersonalMessage.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { items: page.map(messageView), nextCursor: hasMore ? String(page[page.length - 1]._id) : null };
  }, 'list messages');
}

/** Marks every message addressed to `userId` in the conversation as read and tells the other side. */
async function markRead(userId, conversationId, fromSocket) {
  return withDb(async () => {
    const conversation = await requireMemberConversation(userId, conversationId);
    const now = new Date();
    const res = await PersonalMessage.updateMany(
      { conversationId: conversation._id, recipientId: userId, readAt: null },
      { $set: { readAt: now } }
    );
    await Conversation.updateOne({ _id: conversation._id }, { $set: { [`unread.${indexOf(conversation, userId)}`]: 0 } });
    const payload = { conversationId: String(conversation._id), byUserId: String(userId), readAt: now };
    if (res.modifiedCount > 0) registry.sendToUser(otherMember(conversation, userId), 'message.seen', payload);
    registry.sendToUser(userId, 'message.seen', payload, fromSocket); // the reader's other devices clear their badge
    return { conversationId: String(conversation._id), markedRead: res.modifiedCount };
  }, 'mark read');
}

module.exports = { sendMessage, listConversations, getConversationWith, listMessages, markRead };
