'use strict';

const { User, Friendship, Block, Report, UserSettings } = require('../../database/models');
const { AppError } = require('../../utils/errors');
const registry = require('../../websocket/registry');
const presence = require('../presence/presence.service');

function publicUser(u) {
  return {
    id: String(u._id),
    username: u.username,
    displayName: u.displayName || null,
    avatarId: u.avatarId || null,
  };
}

/** Ids of users who blocked `userId` or whom `userId` blocked. */
async function blockedEitherWay(userId) {
  const rows = await Block.find({ $or: [{ blocker: userId }, { blocked: userId }] })
    .select('blocker blocked')
    .lean();
  return new Set(rows.map((r) => (String(r.blocker) === String(userId) ? String(r.blocked) : String(r.blocker))));
}

async function isBlockedEitherWay(a, b) {
  return Boolean(await Block.exists({ $or: [{ blocker: a, blocked: b }, { blocker: b, blocked: a }] }));
}

async function areFriends(a, b) {
  return Boolean(await Friendship.exists({ pairKey: Friendship.makePairKey(a, b), status: 'accepted' }));
}

async function acceptRequestDoc(friendshipFilter) {
  return Friendship.findOneAndUpdate(
    { ...friendshipFilter, status: 'pending' },
    { $set: { status: 'accepted', respondedAt: new Date() } },
    { returnDocument: 'after' }
  );
}

async function sendRequest(meId, username, attempt = 0) {
  const target = await User.findOne({ usernameLower: username.toLowerCase(), status: 'active' });
  if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  const targetId = String(target._id);
  if (targetId === meId) throw new AppError(400, 'CANNOT_ADD_SELF', 'You cannot send a request to yourself');

  const iBlocked = await Block.exists({ blocker: meId, blocked: targetId });
  if (iBlocked) throw new AppError(403, 'USER_BLOCKED', 'You have blocked this user');
  // If THEY blocked me, behave as if the user does not exist (do not reveal the block).
  if (await Block.exists({ blocker: targetId, blocked: meId })) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  }

  const settings = await UserSettings.findOne({ userId: targetId }).select('preferences').lean();
  if (settings && settings.preferences && settings.preferences.friendRequestsFrom === 'nobody') {
    throw new AppError(403, 'REQUESTS_DISABLED', 'This user is not accepting friend requests');
  }

  const pairKey = Friendship.makePairKey(meId, targetId);
  const existing = await Friendship.findOne({ pairKey });
  if (existing) {
    if (existing.status === 'accepted') throw new AppError(409, 'ALREADY_FRIENDS', 'You are already friends');
    if (String(existing.requester) === meId) throw new AppError(409, 'REQUEST_EXISTS', 'Request already sent');
    // They already asked me: sending a request back means "accept".
    const accepted = await acceptRequestDoc({ _id: existing._id });
    if (!accepted) throw new AppError(409, 'REQUEST_EXISTS', 'Request already handled');
    notifyAccepted(accepted, meId);
    return { friendshipId: String(accepted._id), status: 'accepted', autoAccepted: true, user: publicUser(target) };
  }

  let friendship;
  try {
    friendship = await Friendship.create({ requester: meId, recipient: targetId, pairKey });
  } catch (err) {
    // Two requests between the same users at the same moment: re-evaluate once.
    if (err && err.code === 11000 && attempt === 0) return sendRequest(meId, username, 1);
    throw err;
  }
  const me = await User.findById(meId).select('username displayName avatarId').lean();
  registry.sendToUser(targetId, 'friend.request', { requestId: String(friendship._id), from: publicUser(me) });
  return { friendshipId: String(friendship._id), status: 'pending', autoAccepted: false, user: publicUser(target) };
}

function notifyAccepted(friendship, accepterId) {
  const requesterId = String(friendship.requester);
  if (requesterId === accepterId) return;
  User.findById(accepterId)
    .select('username displayName avatarId')
    .lean()
    .then((u) => {
      if (u) registry.sendToUser(requesterId, 'friend.accepted', { friendshipId: String(friendship._id), user: publicUser(u) });
    })
    .catch(() => {});
}

async function acceptRequest(meId, requestId) {
  const accepted = await acceptRequestDoc({ _id: requestId, recipient: meId });
  if (!accepted) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Friend request not found');
  notifyAccepted(accepted, meId);
  return { friendshipId: String(accepted._id), status: 'accepted' };
}

async function rejectRequest(meId, requestId) {
  const res = await Friendship.deleteOne({ _id: requestId, recipient: meId, status: 'pending' });
  if (!res.deletedCount) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Friend request not found');
}

async function cancelRequest(meId, requestId) {
  const res = await Friendship.deleteOne({ _id: requestId, requester: meId, status: 'pending' });
  if (!res.deletedCount) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Friend request not found');
}

async function unfriend(meId, otherId) {
  const res = await Friendship.deleteOne({ pairKey: Friendship.makePairKey(meId, otherId), status: 'accepted' });
  if (!res.deletedCount) throw new AppError(404, 'NOT_FRIENDS', 'You are not friends with this user');
}

function paginate(rows, limit) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { page, nextCursor: hasMore ? String(page[page.length - 1]._id) : null };
}

async function usersById(ids) {
  const users = await User.find({ _id: { $in: ids } }).select('username displayName avatarId').lean();
  return new Map(users.map((u) => [String(u._id), u]));
}

async function listFriends(meId, { limit, cursor }) {
  const filter = { status: 'accepted', $or: [{ requester: meId }, { recipient: meId }] };
  if (cursor) filter._id = { $lt: cursor };
  const rows = await Friendship.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { page, nextCursor } = paginate(rows, limit);
  const otherIds = page.map((r) => (String(r.requester) === meId ? String(r.recipient) : String(r.requester)));
  const [users, online] = await Promise.all([usersById(otherIds), presence.onlineMap(otherIds)]);
  const items = page
    .map((r, i) => ({ r, id: otherIds[i] }))
    .filter(({ id }) => users.has(id))
    .map(({ r, id }) => ({
      friendshipId: String(r._id),
      user: publicUser(users.get(id)),
      online: online[id],
      since: r.respondedAt || r.createdAt,
    }));
  return { items, nextCursor };
}

async function listRequests(meId, { direction, limit, cursor }) {
  const filter = { status: 'pending', ...(direction === 'outgoing' ? { requester: meId } : { recipient: meId }) };
  if (cursor) filter._id = { $lt: cursor };
  const rows = await Friendship.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { page, nextCursor } = paginate(rows, limit);
  const otherIds = page.map((r) => (direction === 'outgoing' ? String(r.recipient) : String(r.requester)));
  const users = await usersById(otherIds);
  const items = page
    .map((r, i) => ({ r, id: otherIds[i] }))
    .filter(({ id }) => users.has(id))
    .map(({ r, id }) => ({ requestId: String(r._id), user: publicUser(users.get(id)), createdAt: r.createdAt }));
  return { items, nextCursor };
}

async function blockUser(meId, targetId) {
  if (targetId === meId) throw new AppError(400, 'CANNOT_BLOCK_SELF', 'You cannot block yourself');
  const target = await User.findById(targetId).select('_id');
  if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  await Block.updateOne({ blocker: meId, blocked: targetId }, { $setOnInsert: { blocker: meId, blocked: targetId } }, { upsert: true });
  // Blocking ends any friendship or pending request in either direction.
  await Friendship.deleteOne({ pairKey: Friendship.makePairKey(meId, targetId) });
}

async function unblockUser(meId, targetId) {
  await Block.deleteOne({ blocker: meId, blocked: targetId });
}

async function listBlocks(meId, { limit, cursor }) {
  const filter = { blocker: meId };
  if (cursor) filter._id = { $lt: cursor };
  const rows = await Block.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { page, nextCursor } = paginate(rows, limit);
  const users = await usersById(page.map((r) => String(r.blocked)));
  const items = page
    .filter((r) => users.has(String(r.blocked)))
    .map((r) => ({ user: publicUser(users.get(String(r.blocked))), blockedAt: r.createdAt }));
  return { items, nextCursor };
}

async function reportUser(meId, { userId, reason, details }) {
  if (userId === meId) throw new AppError(400, 'CANNOT_REPORT_SELF', 'You cannot report yourself');
  const target = await User.findById(userId).select('_id');
  if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
  if (await Report.exists({ reporter: meId, reported: userId, status: 'open' })) {
    throw new AppError(409, 'ALREADY_REPORTED', 'You already have an open report for this user');
  }
  const report = await Report.create({ reporter: meId, reported: userId, reason, details });
  return { reportId: String(report._id) };
}

module.exports = {
  publicUser,
  blockedEitherWay,
  isBlockedEitherWay,
  areFriends,
  sendRequest,
  acceptRequest,
  rejectRequest,
  cancelRequest,
  unfriend,
  listFriends,
  listRequests,
  blockUser,
  unblockUser,
  listBlocks,
  reportUser,
};
