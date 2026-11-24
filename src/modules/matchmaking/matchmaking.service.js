'use strict';

/**
 * Matchmaking queue and friend invitations (D-023).
 * Pairing and game creation run one at a time behind an in-process lock, which is enough for
 * a single instance (D-001). The queue itself is in MongoDB with a TTL, so it survives restarts
 * and can never leave a player queued forever.
 */
const config = require('../../config');
const logger = require('../../utils/logger');
const events = require('../../utils/events');
const { AppError } = require('../../utils/errors');
const { requireObjectId } = require('../../utils/objectId');
const { MatchmakingEntry, Invitation, User } = require('../../database/models');
const registry = require('../../websocket/registry');
const friends = require('../friends/friends.service');
const games = require('../games/games.service');
const { parseTimeControl } = require('../games/timeControl');
const { DEFAULT_VARIANT, isValidVariant } = require('../games/variants');

const QUEUE_TTL_MS = 10 * 60 * 1000;

let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(() => fn());
  lock = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function ensureFree(userId) {
  if (await games.findLiveGameFor(userId)) {
    throw new AppError(409, 'ALREADY_IN_GAME', 'Finish your current game first');
  }
}

/** Validates a time control id and returns its normalised form ("05+03" -> "5+3"), so equal controls pair. */
function requireTimeControl(id) {
  const tc = parseTimeControl(id);
  if (!tc) throw new AppError(400, 'INVALID_TIME_CONTROL', 'Invalid time control (use "<minutes>+<increment seconds>", e.g. "5+3")');
  return tc.id;
}

function randomColors(a, b) {
  return Math.random() < 0.5 ? { whiteId: a, blackId: b } : { whiteId: b, blackId: a };
}

// ---------------------------------------------------------------- queue

async function joinQueue(userId, rawTimeControlId, rated, variant = DEFAULT_VARIANT) {
  const timeControlId = requireTimeControl(rawTimeControlId);
  if (!isValidVariant(variant)) throw new AppError(400, 'INVALID_VARIANT', 'Unknown game variant');
  if (variant !== DEFAULT_VARIANT) rated = false; // variants never touch the standard rating (D-062)
  await games.withDb(async () => {
    await ensureFree(userId);
    const user = await User.findById(userId).select('rating').lean();
    const now = new Date();
    await MatchmakingEntry.findOneAndUpdate(
      { userId },
      {
        $set: {
          timeControlId,
          rated,
          variant,
          rating: (user && user.rating) ?? config.game.startingRating,
          joinedAt: now,
          expiresAt: new Date(now.getTime() + QUEUE_TTL_MS),
        },
      },
      { upsert: true }
    );
  });
  try {
    await tryMatch();
  } catch (err) {
    logger.warn({ reason: err.message }, 'matchmaking attempt failed'); // the periodic tick retries
  }
  return { queued: true, timeControlId, rated, variant };
}

async function leaveQueue(userId) {
  await games.withDb(() => MatchmakingEntry.deleteOne({ userId }));
  return { left: true };
}

/** Pairs waiting players. Returns the number of games created. */
function tryMatch() {
  return withLock(async () => {
    const entries = await MatchmakingEntry.find({}).sort({ joinedAt: 1 }).lean();
    const used = new Set();
    let created = 0;
    for (const a of entries) {
      const aId = String(a.userId);
      if (used.has(aId)) continue;
      if (!registry.isOnline(aId)) {
        await MatchmakingEntry.deleteOne({ _id: a._id });
        used.add(aId);
        continue;
      }
      for (const b of entries) {
        const bId = String(b.userId);
        if (bId === aId || used.has(bId) || !registry.isOnline(bId)) continue;
        if (b.timeControlId !== a.timeControlId || b.rated !== a.rated) continue;
        if ((b.variant || DEFAULT_VARIANT) !== (a.variant || DEFAULT_VARIANT)) continue;
        const waited = (Date.now() - Math.min(a.joinedAt.getTime(), b.joinedAt.getTime())) / 1000;
        const window = config.game.ratingWindowBase + config.game.ratingWindowPerSecond * waited;
        if (Math.abs(a.rating - b.rating) > window) continue;

        const delA = await MatchmakingEntry.deleteOne({ _id: a._id });
        if (delA.deletedCount !== 1) break; // A left the queue meanwhile
        const delB = await MatchmakingEntry.deleteOne({ _id: b._id });
        if (delB.deletedCount !== 1) {
          // B left meanwhile: put A back.
          await MatchmakingEntry.updateOne(
            { userId: a.userId },
            { $setOnInsert: { timeControlId: a.timeControlId, rated: a.rated, variant: a.variant || DEFAULT_VARIANT, rating: a.rating, joinedAt: a.joinedAt, expiresAt: a.expiresAt } },
            { upsert: true }
          );
          continue;
        }
        used.add(aId);
        used.add(bId);
        try {
          await games.createGame({
            ...randomColors(a.userId, b.userId),
            timeControlId: a.timeControlId,
            rated: a.rated,
            variant: a.variant || DEFAULT_VARIANT,
          });
          created += 1;
        } catch (err) {
          logger.warn({ reason: err.message }, 'could not create matched game');
          for (const id of [aId, bId]) registry.sendToUser(id, 'queue.cancelled', { reason: err.code || 'MATCH_FAILED' });
        }
        break;
      }
    }
    return created;
  });
}

// ---------------------------------------------------------------- invitations

async function sendInvite(fromId, toUserId, rawTimeControlId, rated, variant = DEFAULT_VARIANT) {
  requireObjectId(toUserId, 'userId');
  const timeControlId = requireTimeControl(rawTimeControlId);
  if (!isValidVariant(variant)) throw new AppError(400, 'INVALID_VARIANT', 'Unknown game variant');
  if (variant !== DEFAULT_VARIANT) rated = false; // variants never touch the standard rating (D-062)
  if (String(fromId) === String(toUserId)) throw new AppError(400, 'INVALID_OPPONENT', 'Cannot invite yourself');
  return games.withDb(async () => {
    if (!(await friends.areFriends(fromId, toUserId))) {
      throw new AppError(403, 'NOT_FRIENDS', 'You can only invite friends');
    }
    if (!registry.isOnline(toUserId)) throw new AppError(409, 'USER_OFFLINE', 'Your friend is offline');
    await ensureFree(fromId);
    await ensureFree(toUserId);
    // One open invitation per sender: a new one replaces the old.
    await Invitation.updateMany({ fromId, status: 'pending' }, { $set: { status: 'cancelled' } });
    const invite = await Invitation.create({
      fromId,
      toId: toUserId,
      timeControlId,
      rated,
      variant,
      expiresAt: new Date(Date.now() + config.game.inviteTtlMs),
    });
    const from = await User.findById(fromId).select('username').lean();
    registry.sendToUser(toUserId, 'invite.received', {
      inviteId: String(invite._id),
      from: { id: String(fromId), username: from.username },
      timeControlId,
      rated,
      variant,
      expiresAt: invite.expiresAt.toISOString(),
    });
    return { inviteId: String(invite._id), expiresAt: invite.expiresAt.toISOString() };
  });
}

function acceptInvite(userId, inviteId) {
  requireObjectId(inviteId, 'inviteId');
  return withLock(() =>
    games.withDb(async () => {
      const invite = await Invitation.findOne({
        _id: inviteId,
        toId: userId,
        status: 'pending',
        expiresAt: { $gt: new Date() },
      }).lean();
      if (!invite) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invitation not found or expired');
      if (!registry.isOnline(invite.fromId)) throw new AppError(409, 'USER_OFFLINE', 'The inviter is offline');
      await ensureFree(userId);
      await ensureFree(invite.fromId);
      const claimed = await Invitation.findOneAndUpdate({ _id: inviteId, status: 'pending' }, { $set: { status: 'accepted' } });
      if (!claimed) throw new AppError(409, 'CONFLICT', 'Invitation changed; retry');
      let game;
      try {
        game = await games.createGame({
          ...randomColors(invite.fromId, userId),
          timeControlId: invite.timeControlId,
          rated: invite.rated,
          variant: invite.variant || DEFAULT_VARIANT,
        });
      } catch (err) {
        await Invitation.updateOne({ _id: inviteId }, { $set: { status: 'cancelled' } });
        throw err;
      }
      await Invitation.updateOne({ _id: inviteId }, { $set: { gameId: game._id } });
      registry.sendToUser(invite.fromId, 'invite.updated', {
        inviteId: String(inviteId),
        status: 'accepted',
        gameId: String(game._id),
      });
      return { gameId: String(game._id) };
    })
  );
}

async function closeInvite(actorField, otherField, status, userId, inviteId) {
  requireObjectId(inviteId, 'inviteId');
  const invite = await games.withDb(() =>
    Invitation.findOneAndUpdate({ _id: inviteId, [actorField]: userId, status: 'pending' }, { $set: { status } })
  );
  if (!invite) throw new AppError(404, 'INVITE_NOT_FOUND', 'Invitation not found');
  registry.sendToUser(invite[otherField], 'invite.updated', { inviteId: String(inviteId), status });
  return { status };
}

const declineInvite = (userId, inviteId) => closeInvite('toId', 'fromId', 'declined', userId, inviteId);
const cancelInvite = (userId, inviteId) => closeInvite('fromId', 'toId', 'cancelled', userId, inviteId);

// ---------------------------------------------------------------- lifecycle

let tickTimer = null;
const onDisconnected = ({ userId }) => {
  MatchmakingEntry.deleteOne({ userId }).catch(() => {});
};

function start() {
  if (tickTimer) return;
  events.on('user.disconnected', onDisconnected);
  tickTimer = setInterval(() => {
    tryMatch().catch((err) => logger.warn({ reason: err.message }, 'matchmaking tick failed'));
  }, config.game.matchTickMs);
  tickTimer.unref();
}

function stop() {
  if (!tickTimer) return;
  events.off('user.disconnected', onDisconnected);
  clearInterval(tickTimer);
  tickTimer = null;
}

module.exports = {
  joinQueue,
  leaveQueue,
  tryMatch,
  sendInvite,
  acceptInvite,
  declineInvite,
  cancelInvite,
  start,
  stop,
};
