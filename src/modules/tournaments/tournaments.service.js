'use strict';

/**
 * Tournaments (D-052 to D-055): creation, registration, and the sweeper that runs them.
 *
 * Recovery rules (failure scenario 19):
 *  - All state is in MongoDB (`tournaments`, `tournament_players`, the wallet ledger and `games`).
 *    Nothing is kept in RAM except timers, and a timer only calls `tick()`.
 *  - `tick()` looks at stored timestamps and stored results and does whatever is due. Every step is
 *    a conditional update or an idempotent call (ledger keys, notification keys, a unique key on the
 *    game of a pairing), so running it twice, or after a crash, never does anything twice.
 *  - Standings are recomputed from the stored pairings; there are no counters to go stale.
 *  - Money: entry fees, refunds and prizes are ledger rows with fixed keys per (tournament, user).
 */
const config = require('../../config');
const logger = require('../../utils/logger');
const events = require('../../utils/events');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const mongoose = require('mongoose');
const registry = require('../../websocket/registry');
const { Tournament, TournamentPlayer, Transaction, Game, User } = require('../../database/models');
const wallet = require('../economy/wallet.service');
const notifications = require('../notifications/notifications.service');
const games = require('../games/games.service');
const { parseTimeControl } = require('../games/timeControl');
const L = require('./tournaments.logic');

const OPEN = ['registration', 'running'];
const entryKey = (tid, uid) => `tournament:${tid}:entry:${uid}`;
const refundKey = (tid, uid) => `tournament:${tid}:refund:${uid}`;
const prizeKey = (tid, uid) => `tournament:${tid}:prize:${uid}`;
const sid = (value) => String(value);

// ---------------------------------------------------------------- views

async function playerList(tid) {
  const rows = await TournamentPlayer.find({ tournamentId: tid, state: 'joined' }).sort({ _id: 1 }).lean();
  return rows.map((p, i) => ({ userId: sid(p.userId), username: p.username, rating: p.rating, order: i + 1 }));
}

/** The players who take part in a running or finished tournament (fixed at the start). */
async function rosterPlayers(t) {
  const rows = await TournamentPlayer.find({ tournamentId: t._id, userId: { $in: t.roster } }).sort({ _id: 1 }).lean();
  return rows.map((p, i) => ({ userId: sid(p.userId), username: p.username, rating: p.rating, order: i + 1 }));
}

function summary(t, playerCount, joined) {
  return {
    id: sid(t._id),
    name: t.name,
    host: { id: sid(t.hostId), username: t.hostName },
    status: t.status,
    timeControl: t.timeControlId,
    rated: t.rated,
    entryFee: t.entryFee,
    maxPlayers: t.maxPlayers,
    playerCount,
    startsAt: t.startsAt,
    rounds: t.roundsTotal || t.roundsPlanned || null,
    currentRound: t.currentRound,
    joined,
    createdAt: t.createdAt,
  };
}

function pairingView(p, names) {
  const who = (id) => (id ? { id: sid(id), username: names.get(sid(id)) || null } : null);
  return {
    key: p.key,
    kind: p.kind,
    status: p.status,
    white: who(p.whiteId),
    black: who(p.blackId),
    gameId: p.gameId ? sid(p.gameId) : null,
    whiteScore: p.whiteScore ?? null,
    blackScore: p.blackScore ?? null,
    reason: p.reason || null,
    startBy: p.startBy || null,
  };
}

// ---------------------------------------------------------------- create, list, read

async function create(userId, input) {
  const tc = parseTimeControl(input.timeControl);
  if (!tc) throw new AppError(400, 'INVALID_TIME_CONTROL', 'Unknown time control');
  if (input.rounds !== undefined && input.rounds > input.maxPlayers - 1) {
    throw new AppError(400, 'INVALID_ROUNDS', 'Rounds must be at most one less than the maximum number of players');
  }
  const startsAt = new Date(input.startsAt);
  const lead = startsAt.getTime() - Date.now();
  if (Number.isNaN(lead) || lead < config.tournament.minLeadMs || lead > config.tournament.maxLeadMs) {
    throw new AppError(400, 'INVALID_START_TIME', 'The start time is too soon or too far away');
  }
  return withDb(async () => {
    const host = await User.findById(userId).select('username status').lean();
    if (!host || host.status !== 'active') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');
    const open = await Tournament.countDocuments({ hostId: userId, status: { $in: OPEN } });
    if (open >= config.tournament.maxHosted) {
      throw new AppError(409, 'TOURNAMENT_LIMIT', 'You already host the maximum number of open tournaments');
    }
    const doc = await Tournament.create({
      name: input.name,
      hostId: userId,
      hostName: host.username,
      timeControlId: tc.id,
      rated: input.rated,
      entryFee: input.entryFee,
      maxPlayers: input.maxPlayers,
      roundsPlanned: input.rounds ?? null,
      startsAt,
    });
    return { tournament: summary(doc.toObject(), 0, false) };
  }, 'create tournament');
}

async function list(userId, { status, mine, limit, cursor }) {
  return withDb(async () => {
    const filter = {};
    if (status) filter.status = status;
    if (mine) {
      const joined = await TournamentPlayer.find({ userId, state: 'joined' }).select('tournamentId').limit(500).lean();
      filter.$or = [{ hostId: userId }, { _id: { $in: joined.map((p) => p.tournamentId) } }];
    }
    if (cursor) filter._id = { $lt: cursor };
    const rows = await Tournament.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ids = page.map((t) => t._id);
    const counts = await TournamentPlayer.aggregate([
      { $match: { tournamentId: { $in: ids }, state: 'joined' } },
      { $group: { _id: '$tournamentId', n: { $sum: 1 } } },
    ]);
    const countOf = new Map(counts.map((c) => [sid(c._id), c.n]));
    const mineRows = await TournamentPlayer.find({ tournamentId: { $in: ids }, userId, state: 'joined' }).select('tournamentId').lean();
    const joinedSet = new Set(mineRows.map((p) => sid(p.tournamentId)));
    return {
      items: page.map((t) => summary(t, countOf.get(sid(t._id)) || 0, joinedSet.has(sid(t._id)))),
      nextCursor: hasMore ? sid(page[page.length - 1]._id) : null,
    };
  }, 'list tournaments');
}

async function get(userId, tournamentId) {
  return withDb(async () => {
    const t = await Tournament.findById(tournamentId).lean();
    if (!t) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found');
    const started = t.status === 'running' || t.status === 'finished';
    const players = started && t.roster.length ? await rosterPlayers(t) : await playerList(t._id);
    const names = new Map(players.map((p) => [p.userId, p.username]));
    const joined = players.some((p) => p.userId === sid(userId));
    const view = summary(t, players.length, joined);
    view.entrants = players.map((p) => ({ id: p.userId, username: p.username, rating: p.rating }));
    view.startedAt = t.startedAt || null;
    view.finishedAt = t.finishedAt || null;
    view.cancelReason = t.cancelReason || null;
    view.nextRoundAt = t.nextRoundAt || null;
    if (started) {
      const all = t.rounds.flatMap((r) => r.pairings);
      view.standings = L.standings(players, all).map((r) => ({
        place: r.place,
        userId: r.userId,
        username: names.get(r.userId) || null,
        score: r.score,
        buchholz: r.buchholz,
        rating: r.rating,
        played: r.played,
      }));
      view.rounds = t.rounds.map((r) => ({
        number: r.number,
        startedAt: r.startedAt,
        doneAt: r.doneAt || null,
        pairings: r.pairings.map((p) => pairingView(p, names)),
      }));
    }
    view.prizes = t.prizes.map((p) => ({ place: p.place, userId: sid(p.userId), username: names.get(sid(p.userId)) || null, amount: p.amount }));
    return { tournament: view };
  }, 'read tournament');
}

// ---------------------------------------------------------------- registration and money

/** Pays back an entry fee, once. Safe to call again; does nothing if the user was never charged. */
async function payRefund(player, entryFee) {
  const filter = { _id: player._id, refundPending: true };
  if (entryFee > 0) {
    const entry = await Transaction.findOne({ key: entryKey(player.tournamentId, player.userId) }).select('state').lean();
    if (entry && entry.state === 'pending') return false; // the charge is still being finished by the wallet reconciler: try again later
    if (entry) {
      await wallet.credit({
        key: refundKey(player.tournamentId, player.userId),
        userId: player.userId,
        amount: entryFee,
        reason: 'tournament_refund',
        ref: sid(player.tournamentId),
      });
    }
  }
  await TournamentPlayer.updateOne(filter, { $set: { refundPending: false } });
  return true;
}

/** Withdraws a player and refunds the fee. The refund is also retried by the sweeper if it fails here. */
async function evict(player, entryFee) {
  const res = await TournamentPlayer.findOneAndUpdate(
    { _id: player._id, state: { $in: ['pending', 'joined'] } },
    { $set: { state: 'withdrawn', refundPending: true } },
    { returnDocument: 'after' }
  ).lean();
  const current = res || (await TournamentPlayer.findById(player._id).lean());
  if (current && current.refundPending) {
    try {
      await payRefund(current, entryFee);
    } catch (err) {
      logger.warn({ reason: err.message }, 'tournament refund failed, the sweeper will retry');
    }
  }
}

async function join(userId, tournamentId) {
  return withDb(async () => {
    const t = await Tournament.findById(tournamentId).lean();
    if (!t) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found');
    if (t.status !== 'registration' || Date.now() >= new Date(t.startsAt).getTime()) {
      throw new AppError(409, 'TOURNAMENT_CLOSED', 'Registration is closed');
    }
    const user = await User.findById(userId).select('username rating status').lean();
    if (!user || user.status !== 'active') throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active');

    let player = await TournamentPlayer.findOne({ tournamentId: t._id, userId }).lean();
    if (player && player.state === 'joined') return { joined: true, duplicate: true };
    if (player && player.state === 'withdrawn') {
      throw new AppError(409, 'TOURNAMENT_ALREADY_LEFT', 'You left this tournament and cannot join it again');
    }
    if (!player) {
      try {
        player = (
          await TournamentPlayer.create({
            tournamentId: t._id,
            userId,
            username: user.username,
            rating: user.rating ?? config.game.startingRating,
          })
        ).toObject();
      } catch (err) {
        if (!(err && err.code === 11000)) throw err;
        player = await TournamentPlayer.findOne({ tournamentId: t._id, userId }).lean(); // the same user asked twice at once
        if (player && player.state === 'joined') return { joined: true, duplicate: true };
      }
    }

    // Charge the fee (exactly once, by ledger key). Not enough coins: the pending record is dropped.
    if (t.entryFee > 0) {
      try {
        await wallet.debit({ key: entryKey(t._id, userId), userId, amount: t.entryFee, reason: 'tournament_entry', ref: sid(t._id) });
      } catch (err) {
        if (err && err.code === 'INSUFFICIENT_COINS') await TournamentPlayer.deleteOne({ _id: player._id, state: 'pending' });
        throw err;
      }
    }

    const marked = await TournamentPlayer.findOneAndUpdate(
      { _id: player._id, state: 'pending' },
      { $set: { state: 'joined' } },
      { returnDocument: 'after' }
    ).lean();
    const current = marked || (await TournamentPlayer.findById(player._id).lean());
    if (!current || current.state !== 'joined') throw new AppError(409, 'CONFLICT', 'Registration changed at the same moment; retry');

    // Capacity: players are ranked by record id; only the first `maxPlayers` keep their seat. Two joins
    // at the last seat both get here, and exactly one of them is first.
    const rank = await TournamentPlayer.countDocuments({ tournamentId: t._id, state: 'joined', _id: { $lt: current._id } });
    if (rank >= t.maxPlayers) {
      await evict(current, t.entryFee);
      throw new AppError(409, 'TOURNAMENT_FULL', 'The tournament is full');
    }
    // Did the tournament start or get cancelled while we were joining? Late joiners are refunded.
    const fresh = await Tournament.findById(t._id).select('status roster').lean();
    const inRoster = fresh.roster.some((id) => sid(id) === sid(userId));
    if (fresh.status === 'cancelled' || (fresh.status !== 'registration' && !inRoster)) {
      await evict(current, t.entryFee);
      throw new AppError(409, 'TOURNAMENT_CLOSED', 'Registration is closed');
    }
    return { joined: true, duplicate: false };
  }, 'join tournament');
}

async function leave(userId, tournamentId) {
  return withDb(async () => {
    const t = await Tournament.findById(tournamentId).lean();
    if (!t) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found');
    if (t.status !== 'registration') throw new AppError(409, 'TOURNAMENT_STARTED', 'The tournament has started; the entry fee is not refunded');
    const player = await TournamentPlayer.findOneAndUpdate(
      { tournamentId: t._id, userId, state: 'joined' },
      { $set: { state: 'withdrawn', refundPending: true } },
      { returnDocument: 'after' }
    ).lean();
    if (!player) {
      const existing = await TournamentPlayer.findOne({ tournamentId: t._id, userId }).lean();
      if (existing && existing.state === 'withdrawn') return { left: true, duplicate: true };
      throw new AppError(404, 'NOT_JOINED', 'You have not joined this tournament');
    }
    // The tournament may have started between the check above and the update: then we are in the roster
    // and the leave is undone (the start won the race).
    const fresh = await Tournament.findById(t._id).select('status roster').lean();
    if (fresh.status !== 'registration' && fresh.roster.some((id) => sid(id) === sid(userId))) {
      await TournamentPlayer.updateOne({ _id: player._id, state: 'withdrawn' }, { $set: { state: 'joined', refundPending: false } });
      throw new AppError(409, 'TOURNAMENT_STARTED', 'The tournament has started; the entry fee is not refunded');
    }
    try {
      await payRefund(player, t.entryFee);
    } catch (err) {
      logger.warn({ reason: err.message }, 'tournament refund failed, the sweeper will retry');
    }
    return { left: true, duplicate: false };
  }, 'leave tournament');
}

async function notifyAll(userIds, type, dataFor, keyFor) {
  for (const userId of userIds) {
    await notifications.notify({ userId, type, data: dataFor(sid(userId)), key: keyFor(sid(userId)) });
  }
}

/** Cancels a tournament that has not started. Everyone who joined is refunded. Returns false if it already started. */
async function cancelTournament(tournamentId, reason, now = Date.now()) {
  const t = await Tournament.findById(tournamentId).lean();
  if (!t) return false;
  const joined = await TournamentPlayer.find({ tournamentId: t._id, state: 'joined' }).select('userId').lean();
  const res = await Tournament.updateOne(
    { _id: t._id, status: 'registration' },
    { $set: { status: 'cancelled', cancelledAt: new Date(now), cancelReason: reason } }
  );
  if (res.modifiedCount !== 1) return false;
  await TournamentPlayer.updateMany(
    { tournamentId: t._id, state: { $in: ['pending', 'joined'] } },
    { $set: { state: 'withdrawn', refundPending: true } }
  );
  await notifyAll(
    joined.map((p) => p.userId),
    'tournament_cancelled',
    () => ({ tournamentId: sid(t._id), name: t.name, reason, entryFee: t.entryFee }),
    (u) => `tournament:${t._id}:cancelled:${u}`
  );
  await healRefunds();
  return true;
}

async function cancelByHost(userId, tournamentId) {
  return withDb(async () => {
    const t = await Tournament.findById(tournamentId).lean();
    if (!t) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found');
    if (sid(t.hostId) !== sid(userId)) throw new AppError(403, 'NOT_HOST', 'Only the host can cancel the tournament');
    if (t.status === 'cancelled') return { cancelled: true, duplicate: true };
    if (t.status !== 'registration') throw new AppError(409, 'TOURNAMENT_STARTED', 'The tournament has already started');
    const done = await cancelTournament(t._id, 'host_cancelled');
    if (!done) throw new AppError(409, 'TOURNAMENT_STARTED', 'The tournament has already started');
    return { cancelled: true, duplicate: false };
  }, 'cancel tournament');
}

// ---------------------------------------------------------------- running a tournament

function buildRound(number, pairs, now) {
  return {
    number,
    startedAt: new Date(now),
    pairings: pairs.map((p, i) => {
      const key = `r${number}p${i}`;
      if (p.kind === 'bye') {
        return { key, kind: 'bye', whiteId: p.whiteId, blackId: null, status: 'done', whiteScore: 1, blackScore: 0, reason: 'bye' };
      }
      return { key, kind: 'game', whiteId: p.whiteId, blackId: p.blackId, status: 'pending', startBy: new Date(now + config.tournament.showUpMs) };
    }),
  };
}

async function notifyRound(t, round, players) {
  const names = new Map(players.map((p) => [p.userId, p.username]));
  for (const p of round.pairings) {
    const info = (me, other, color) => ({
      tournamentId: sid(t._id),
      name: t.name,
      round: round.number,
      rounds: t.roundsTotal,
      color,
      opponent: other ? { id: sid(other), username: names.get(sid(other)) || null } : null,
      bye: !other,
      startBy: p.startBy || null,
    });
    await notifications.notify({
      userId: p.whiteId,
      type: 'tournament_round',
      data: info(p.whiteId, p.blackId, 'w'),
      key: `tournament:${t._id}:round:${round.number}:${p.whiteId}`,
    });
    if (p.blackId) {
      await notifications.notify({
        userId: p.blackId,
        type: 'tournament_round',
        data: info(p.blackId, p.whiteId, 'b'),
        key: `tournament:${t._id}:round:${round.number}:${p.blackId}`,
      });
    }
  }
}

async function startTournament(t, now) {
  const players = await playerList(t._id);
  if (players.length < L.MIN_PLAYERS) {
    await cancelTournament(t._id, 'not_enough_players', now);
    return;
  }
  const total = Math.max(1, Math.min(players.length - 1, t.roundsPlanned || L.defaultRounds(players.length)));
  const pairs = L.pairRound(L.standings(players, []), L.history([]));
  const round = buildRound(1, pairs, now);
  const res = await Tournament.updateOne(
    { _id: t._id, status: 'registration' },
    {
      $set: {
        status: 'running',
        startedAt: new Date(now),
        roster: players.map((p) => p.userId),
        roundsTotal: total,
        currentRound: 1,
        nextRoundAt: null,
        rounds: [round],
      },
    }
  );
  if (res.modifiedCount !== 1) return; // another tick (or a host cancel) got there first
  const started = { ...t, roundsTotal: total };
  await notifyAll(
    players.map((p) => p.userId),
    'tournament_starting',
    () => ({ tournamentId: sid(t._id), name: t.name, players: players.length, rounds: total, timeControl: t.timeControlId, entryFee: t.entryFee }),
    (u) => `tournament:${t._id}:start:${u}`
  );
  await notifyRound(started, round, players);
}

async function isPresent(userId) {
  return registry.isOnline(userId) && !(await games.findLiveGameFor(userId));
}

/** Writes the result of one pairing once. Returns true if this call wrote it. */
async function recordPairing(tournamentId, roundNumber, key, fields) {
  const set = {};
  for (const [name, value] of Object.entries(fields)) set[`rounds.$[r].pairings.$[p].${name}`] = value;
  const res = await Tournament.updateOne(
    { _id: tournamentId, status: 'running' },
    { $set: set },
    { arrayFilters: [{ 'r.number': roundNumber }, { 'p.key': key, 'p.status': { $ne: 'done' } }] }
  );
  return res.modifiedCount === 1;
}

function resultFields(game) {
  if (game.status === 'aborted') return { status: 'done', gameId: game._id, whiteScore: 0.5, blackScore: 0.5, reason: 'aborted' };
  const [whiteScore, blackScore] = L.scoresForResult(game.result);
  return { status: 'done', gameId: game._id, whiteScore, blackScore, reason: 'result' };
}

const roundOfKey = (key) => Number((/^r(\d+)p\d+$/.exec(key) || [])[1]);

async function settlePairing(t, round, p, now) {
  if (p.kind === 'bye' || p.status === 'done') return;
  let game = null;
  if (p.status === 'pending') {
    // A crash may have left a game behind that was never linked to the pairing.
    game = await Game.findOne({ 'tournament.tournamentId': t._id, 'tournament.key': p.key }).lean();
    if (!game) {
      if ((await isPresent(p.whiteId)) && (await isPresent(p.blackId))) {
        try {
          game = await games.createGame({
            whiteId: p.whiteId,
            blackId: p.blackId,
            timeControlId: t.timeControlId,
            rated: t.rated,
            tournament: { tournamentId: t._id, key: p.key },
          });
        } catch (err) {
          if (!(err instanceof AppError) || err.code === 'TEMPORARILY_UNAVAILABLE') {
            logger.warn({ reason: err.message, tournament: sid(t._id), key: p.key }, 'could not create a tournament game, will retry');
            return;
          }
          // ALREADY_IN_GAME and similar: somebody is busy; the show-up time decides below.
          game = null;
        }
      }
      if (!game) {
        if (p.startBy && now >= new Date(p.startBy).getTime()) await forfeit(t, round, p);
        return;
      }
    }
    const linked = await recordPairing(t._id, round.number, p.key, { status: 'playing', gameId: game._id });
    if (linked) {
      for (const [userId, color] of [[p.whiteId, 'w'], [p.blackId, 'b']]) {
        await notifications.notify({
          userId,
          type: 'tournament_game_ready',
          data: { tournamentId: sid(t._id), name: t.name, round: round.number, gameId: sid(game._id), color },
          key: `tournament:${t._id}:game:${p.key}:${userId}`,
        });
      }
    }
  } else {
    game = p.gameId ? await Game.findById(p.gameId).lean() : null;
  }
  if (game && !Game.LIVE_STATUSES.includes(game.status)) {
    const fresh = await Game.findById(game._id).lean(); // createGame returns the creation snapshot
    if (fresh && !Game.LIVE_STATUSES.includes(fresh.status)) await recordPairing(t._id, round.number, p.key, resultFields(fresh));
  }
}

async function forfeit(t, round, p) {
  const whiteHere = await isPresent(p.whiteId);
  const blackHere = await isPresent(p.blackId);
  let fields;
  if (!whiteHere && !blackHere) fields = { status: 'done', whiteScore: 0, blackScore: 0, reason: 'double_forfeit' };
  else if (whiteHere) fields = { status: 'done', whiteScore: 1, blackScore: 0, reason: 'forfeit' };
  else fields = { status: 'done', whiteScore: 0, blackScore: 1, reason: 'forfeit' };
  await recordPairing(t._id, round.number, p.key, fields);
}

async function startNextRound(t, players, now) {
  const all = t.rounds.flatMap((r) => r.pairings);
  const pairs = L.pairRound(L.standings(players, all), L.history(all));
  const number = t.currentRound + 1;
  const round = buildRound(number, pairs, now);
  const res = await Tournament.updateOne(
    { _id: t._id, status: 'running', currentRound: t.currentRound, nextRoundAt: { $lte: new Date(now) } },
    { $push: { rounds: round }, $set: { currentRound: number, nextRoundAt: null } }
  );
  if (res.modifiedCount === 1) await notifyRound(t, round, players);
}

async function finishTournament(t, players, now) {
  const all = t.rounds.flatMap((r) => r.pairings);
  const table = L.standings(players, all);
  const pool = t.entryFee * players.length;
  const prizes = L.prizeShares(players.length, pool).map((amount, i) => ({ userId: table[i].userId, place: i + 1, amount }));
  const res = await Tournament.updateOne(
    { _id: t._id, status: 'running' },
    { $set: { status: 'finished', finishedAt: new Date(now), prizes, prizesPaid: prizes.length === 0 } }
  );
  if (res.modifiedCount !== 1) return;
  const prizeOf = new Map(prizes.map((p) => [p.userId, p.amount]));
  const rowOf = new Map(table.map((r) => [r.userId, r]));
  await notifyAll(
    players.map((p) => p.userId),
    'tournament_finished',
    (u) => ({ tournamentId: sid(t._id), name: t.name, place: rowOf.get(u).place, score: rowOf.get(u).score, prize: prizeOf.get(u) || 0 }),
    (u) => `tournament:${t._id}:finished:${u}`
  );
  await payPrizes(await Tournament.findById(t._id).lean());
}

/** Pays the stored prizes. Idempotent: ledger and notification keys are fixed per (tournament, user). */
async function payPrizes(t) {
  if (!t || t.status !== 'finished' || t.prizesPaid) return;
  for (const prize of t.prizes) {
    await wallet.credit({
      key: prizeKey(t._id, prize.userId),
      userId: prize.userId,
      amount: prize.amount,
      reason: 'tournament_prize',
      ref: sid(t._id),
    });
    await notifications.notify({
      userId: prize.userId,
      type: 'tournament_prize',
      data: { tournamentId: sid(t._id), name: t.name, place: prize.place, amount: prize.amount },
      key: `tournament:${t._id}:prize:${prize.userId}`,
    });
  }
  await Tournament.updateOne({ _id: t._id, prizesPaid: false }, { $set: { prizesPaid: true } });
}

/** Moves one running tournament forward as far as the stored data allows. Safe to call at any time. */
async function advance(tournamentId, now = Date.now()) {
  let t = await Tournament.findById(tournamentId).lean();
  if (!t || t.status !== 'running') return;
  const players = await rosterPlayers(t);
  let round = t.rounds[t.currentRound - 1];
  if (!round) return;

  if (!round.doneAt) {
    for (const p of round.pairings) await settlePairing(t, round, p, now);
    t = await Tournament.findById(tournamentId).lean();
    round = t.rounds[t.currentRound - 1];
    if (!round.pairings.every((p) => p.status === 'done')) return;
    await Tournament.updateOne(
      { _id: t._id, status: 'running', currentRound: round.number },
      { $set: { 'rounds.$[r].doneAt': new Date(now), nextRoundAt: new Date(now + config.tournament.roundBreakMs) } },
      { arrayFilters: [{ 'r.number': round.number, 'r.doneAt': { $exists: false } }] }
    );
    t = await Tournament.findById(tournamentId).lean();
    round = t.rounds[t.currentRound - 1];
  }
  if (!round.doneAt) return;
  if (t.currentRound >= t.roundsTotal) return finishTournament(t, players, now);
  if (t.nextRoundAt && now >= new Date(t.nextRoundAt).getTime()) await startNextRound(t, players, now);
}

// ---------------------------------------------------------------- healing

/** Pays refunds that a crash or a failure left unpaid, and drops joins that never finished. */
async function healRefunds(now = Date.now()) {
  const stale = new Date(now - 2 * config.economy.pendingAgeMs);
  const stuck = await TournamentPlayer.find({ state: 'pending', updatedAt: { $lt: stale } }).limit(100).lean();
  for (const player of stuck) {
    const t = await Tournament.findById(player.tournamentId).select('entryFee').lean();
    await evict(player, t ? t.entryFee : 0);
  }
  const due = await TournamentPlayer.find({ refundPending: true }).limit(100).lean();
  const fees = new Map();
  for (const player of due) {
    const key = sid(player.tournamentId);
    if (!fees.has(key)) {
      const t = await Tournament.findById(player.tournamentId).select('entryFee').lean();
      fees.set(key, t ? t.entryFee : 0);
    }
    try {
      await payRefund(player, fees.get(key));
    } catch (err) {
      if (!(err instanceof AppError)) logger.warn({ reason: err.message }, 'tournament refund failed for a player');
    }
  }
}

// ---------------------------------------------------------------- administrator tools (D-059)

/** Admin repair: the sweeper's own idempotent steps, for ONE tournament, on demand. Safe to repeat. */
async function repair(tournamentId, now = Date.now()) {
  return withDb(async () => {
    let t = await Tournament.findById(tournamentId).lean();
    if (!t) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found');
    await healRefunds(now);
    if (t.status === 'registration' && new Date(t.startsAt).getTime() <= now) await startTournament(t, now);
    t = await Tournament.findById(tournamentId).lean();
    if (t.status === 'running') await advance(t._id, now);
    t = await Tournament.findById(tournamentId).lean();
    if (t.status === 'finished' && !t.prizesPaid) await payPrizes(t);
    t = await Tournament.findById(tournamentId).lean();
    return { id: sid(t._id), status: t.status, currentRound: t.currentRound, roundsTotal: t.roundsTotal, prizesPaid: t.prizesPaid };
  }, 'repair tournament');
}

/**
 * Admin cancel for a tournament in registration OR running. Every joined player is refunded (a running
 * tournament has paid no prizes yet). Games already in progress are not aborted: they just stop counting.
 */
async function adminCancel(tournamentId, reason, now = Date.now()) {
  return withDb(async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const t = await Tournament.findById(tournamentId).lean();
      if (!t) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Tournament not found');
      if (t.status === 'cancelled') return { cancelled: true, duplicate: true };
      if (t.status === 'finished') {
        throw new AppError(409, 'TOURNAMENT_FINISHED', 'The tournament is finished; use repair if its prizes are unpaid');
      }
      if (t.status === 'registration') {
        if (await cancelTournament(t._id, reason, now)) return { cancelled: true, duplicate: false };
        continue; // it started meanwhile: look again
      }
      const joined = await TournamentPlayer.find({ tournamentId: t._id, state: 'joined' }).select('userId').lean();
      const res = await Tournament.updateOne(
        { _id: t._id, status: 'running' },
        { $set: { status: 'cancelled', cancelledAt: new Date(now), cancelReason: reason } }
      );
      if (res.modifiedCount !== 1) continue; // finished or cancelled meanwhile: look again
      await TournamentPlayer.updateMany(
        { tournamentId: t._id, state: { $in: ['pending', 'joined'] } },
        { $set: { state: 'withdrawn', refundPending: true } }
      );
      await notifyAll(
        joined.map((p) => p.userId),
        'tournament_cancelled',
        () => ({ tournamentId: sid(t._id), name: t.name, reason, entryFee: t.entryFee }),
        (u) => `tournament:${t._id}:cancelled:${u}`
      );
      await healRefunds();
      return { cancelled: true, duplicate: false };
    }
    throw new AppError(409, 'TOURNAMENT_BUSY', 'The tournament changed while cancelling; try again');
  }, 'cancel tournament (admin)');
}
// ---------------------------------------------------------------- sweeper

let timer = null;
let busy = false;
let started = false;

/** One pass over everything that is due. Idempotent: overlapping or repeated calls do no harm. */
async function tick(now = Date.now()) {
  if (mongoose.connection.readyState !== 1) return null;
  if (busy) return null;
  busy = true;
  try {
    await healRefunds(now);
    const toStart = await Tournament.find({ status: 'registration', startsAt: { $lte: new Date(now) } }).limit(20).lean();
    for (const t of toStart) await guarded('start', t, () => startTournament(t, now));
    const running = await Tournament.find({ status: 'running' }).select('_id').limit(50).lean();
    for (const t of running) await guarded('advance', t, () => advance(t._id, now));
    const unpaid = await Tournament.find({ status: 'finished', prizesPaid: false }).limit(20).lean();
    for (const t of unpaid) await guarded('prizes', t, () => payPrizes(t));
    return { started: toStart.length, running: running.length, unpaid: unpaid.length };
  } catch (err) {
    logger.warn({ reason: err.message }, 'tournament sweeper failed');
    return null;
  } finally {
    busy = false;
  }
}

async function guarded(what, t, fn) {
  try {
    await fn();
  } catch (err) {
    logger.warn({ reason: err.message, what, tournament: sid(t._id) }, 'tournament step failed, will retry');
  }
}

/** A tournament game ended: record its result at once instead of waiting for the next tick. */
async function onGameChanged(game) {
  try {
    if (!game || !game.tournament || !game.tournament.tournamentId) return;
    if (Game.LIVE_STATUSES.includes(game.status)) return;
    const tid = game.tournament.tournamentId;
    await recordPairing(tid, roundOfKey(game.tournament.key), game.tournament.key, resultFields(game));
    await advance(tid);
  } catch (err) {
    logger.warn({ reason: err.message }, 'could not record a tournament game result, the sweeper will');
  }
}

function start() {
  if (started) return;
  started = true;
  events.on('game.state.changed', onGameChanged);
  timer = setInterval(() => {
    tick();
  }, config.game.matchTickMs);
  timer.unref();
}

/** Stops the timer and the result listener, then waits (at most 5 s) for a tick that is already running, so nothing is written after stop() has returned. */
async function stop() {
  if (!started) return;
  started = false;
  events.off('game.state.changed', onGameChanged);
  clearInterval(timer);
  timer = null;
  const deadline = Date.now() + 5000;
  while (busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

module.exports = {
  create,
  list,
  get,
  join,
  leave,
  cancelByHost,
  repair,
  adminCancel,
  tick,
  advance,
  healRefunds,
  start,
  stop,
};
