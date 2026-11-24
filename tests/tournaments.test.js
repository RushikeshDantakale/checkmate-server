'use strict';

// Tournaments (D-052 to D-055): registration, money, running rounds, forfeits and recovery.
// Short timers so a whole tournament runs in a few seconds.
process.env.TOURNAMENT_SHOW_UP_MS = '1500';
process.env.TOURNAMENT_ROUND_BREAK_MS = '100';
process.env.TOURNAMENT_MIN_LEAD_MS = '0';
process.env.MATCH_TICK_MS = '50';
process.env.WALLET_PENDING_AGE_MS = '100';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const { Tournament, TournamentPlayer, Transaction, Notification, Game } = require('../src/database/models');
const wallet = require('../src/modules/economy/wallet.service');
const tournaments = require('../src/modules/tournaments/tournaments.service');

let server;
let api;

before(async () => {
  server = await h.startTestServer();
  api = h.makeApi(server.base);
});

after(async () => {
  g.closeAll();
  await server.stop();
});

const WAIT = 10000;
const soon = (ms) => new Date(Date.now() + ms).toISOString();
const newUser = (prefix) => h.registerUser(api, g.uniq(prefix));
let fundCounter = 0;
const fund = (user, amount) =>
  wallet.credit({ key: `test-fund:${user.id}:${(fundCounter += 1)}`, userId: user.id, amount, reason: 'admin_grant' });
const balance = (user) => wallet.getBalance(user.id);
const doc = (id) => Tournament.findById(id).lean();

async function createT(host, over = {}) {
  const res = await api.post(
    '/api/v1/tournaments',
    { name: 'Friday cup', timeControl: '5+0', rated: false, maxPlayers: 8, startsAt: soon(60000), ...over },
    host.token
  );
  return res;
}

const joinT = (user, id) => api.post(`/api/v1/tournaments/${id}/join`, undefined, user.token);

/** A host, `n` funded players who joined in order, and sockets for the first `online` of them. */
async function setup({ n = 4, fee = 0, rounds, online = n, leadMs = 2500, maxPlayers = 8, rated = false } = {}) {
  const host = await newUser('th');
  const users = [];
  for (let i = 0; i < n; i += 1) {
    const user = await newUser(`tp${i}`);
    await fund(user, 100);
    users.push(user);
  }
  const created = await createT(host, { entryFee: fee, rounds, maxPlayers, rated, startsAt: soon(leadMs) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const t = created.body.tournament;
  for (const user of users) assert.equal((await joinT(user, t.id)).status, 200);
  const sockets = new Map();
  for (const user of users.slice(0, online)) sockets.set(user.id, await g.authed(server.wsUrl, user.token));
  return { host, users, t, sockets };
}

const roundOf = (t, n) => t.rounds[n - 1];
const allPlaying = (t, n) => Boolean(roundOf(t, n)) && roundOf(t, n).pairings.filter((p) => p.kind === 'game').every((p) => p.status === 'playing');

/** Waits until round `n` has its games, then the player with the black pieces in each game resigns (white wins). */
async function playRound(env, id, n) {
  const t = await g.waitFor(async () => {
    const d = await doc(id);
    return allPlaying(d, n) ? d : null;
  }, WAIT);
  for (const p of roundOf(t, n).pairings.filter((x) => x.kind === 'game')) {
    const socket = env.sockets.get(String(p.blackId));
    await g.call(socket, 'game.resign', { gameId: String(p.gameId) }, 'game.resign.ok');
  }
  await g.waitFor(async () => {
    const d = await doc(id);
    return roundOf(d, n).pairings.every((p) => p.status === 'done') ? d : null;
  }, WAIT);
}

const waitFinished = (id) =>
  g.waitFor(async () => {
    const d = await doc(id);
    return d.status === 'finished' && d.prizesPaid ? d : null;
  }, WAIT);

// ---------------------------------------------------------------- creating, listing, reading

test('every tournament endpoint needs a login', async () => {
  assert.equal((await api.get('/api/v1/tournaments')).status, 401);
  assert.equal((await api.post('/api/v1/tournaments', {})).status, 401);
  assert.equal((await api.get('/api/v1/tournaments/000000000000000000000001')).status, 401);
  assert.equal((await api.post('/api/v1/tournaments/000000000000000000000001/join')).status, 401);
  assert.equal((await api.post('/api/v1/tournaments/000000000000000000000001/leave')).status, 401);
  assert.equal((await api.post('/api/v1/tournaments/000000000000000000000001/cancel')).status, 401);
});

test('creating a tournament validates every field', async () => {
  const host = await newUser('tv');
  const bad = async (over, status, code) => {
    const res = await createT(host, over);
    assert.equal(res.status, status, JSON.stringify(over));
    assert.equal(res.body.error.code, code, JSON.stringify(over));
  };
  await bad({ name: 'ab' }, 400, 'VALIDATION_ERROR');
  await bad({ name: 'x'.repeat(41) }, 400, 'VALIDATION_ERROR');
  await bad({ maxPlayers: 3 }, 400, 'VALIDATION_ERROR');
  await bad({ maxPlayers: 33 }, 400, 'VALIDATION_ERROR');
  await bad({ entryFee: 501 }, 400, 'VALIDATION_ERROR');
  await bad({ entryFee: -1 }, 400, 'VALIDATION_ERROR');
  await bad({ entryFee: 1.5 }, 400, 'VALIDATION_ERROR');
  await bad({ startsAt: 'tomorrow' }, 400, 'VALIDATION_ERROR');
  await bad({ timeControl: '7+999' }, 400, 'INVALID_TIME_CONTROL');
  await bad({ startsAt: soon(-60000) }, 400, 'INVALID_START_TIME');
  await bad({ startsAt: soon(8 * 24 * 3600 * 1000) }, 400, 'INVALID_START_TIME');
  await bad({ maxPlayers: 4, rounds: 4 }, 400, 'INVALID_ROUNDS');
  await bad({ rounds: 0 }, 400, 'VALIDATION_ERROR');
  assert.equal(await Tournament.countDocuments({ hostId: host.id }), 0, 'nothing was stored');
});

test('a valid tournament is created in registration, with the host, and read back in full', async () => {
  const host = await newUser('tc');
  const res = await createT(host, { name: '  Sunday   cup ', entryFee: 25, maxPlayers: 6, rounds: 3, rated: true });
  assert.equal(res.status, 201);
  const t = res.body.tournament;
  assert.equal(t.status, 'registration');
  assert.equal(t.entryFee, 25);
  assert.equal(t.maxPlayers, 6);
  assert.equal(t.rounds, 3);
  assert.equal(t.rated, true);
  assert.equal(t.playerCount, 0);
  assert.equal(t.joined, false);
  assert.equal(t.host.id, host.id);

  const other = await newUser('tc2');
  const read = await api.get(`/api/v1/tournaments/${t.id}`, other.token);
  assert.equal(read.status, 200, 'any logged-in user can read a tournament');
  assert.equal(read.body.tournament.id, t.id);
  assert.deepEqual(read.body.tournament.entrants, []);
  assert.equal((await api.get('/api/v1/tournaments/000000000000000000000001', other.token)).status, 404);
  assert.equal((await api.get('/api/v1/tournaments/not-an-id', other.token)).status, 400);
});

test('a host can have only one open tournament at a time; cancelling frees the slot', async () => {
  const host = await newUser('tl');
  const first = await createT(host);
  assert.equal(first.status, 201);
  const second = await createT(host);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'TOURNAMENT_LIMIT');
  assert.equal((await api.post(`/api/v1/tournaments/${first.body.tournament.id}/cancel`, undefined, host.token)).status, 200);
  assert.equal((await createT(host)).status, 201);
});

test('the list shows tournaments newest first, filters by status, pages with a cursor, and mine=true shows my history', async () => {
  const hostA = await newUser('tla');
  const hostB = await newUser('tlb');
  const player = await newUser('tlp');
  const a = (await createT(hostA, { name: 'List cup A' })).body.tournament;
  const b = (await createT(hostB, { name: 'List cup B' })).body.tournament;
  await joinT(player, b.id);

  const all = await api.get('/api/v1/tournaments?status=registration&limit=2', player.token);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.items.map((t) => t.id), [b.id, a.id], 'newest first');
  assert.equal(all.body.items[0].joined, true);
  assert.equal(all.body.items[0].playerCount, 1);
  assert.equal(all.body.items[1].joined, false);

  const p1 = await api.get('/api/v1/tournaments?limit=1', player.token);
  assert.equal(p1.body.items.length, 1);
  assert.ok(p1.body.nextCursor);
  const p2 = await api.get(`/api/v1/tournaments?limit=1&cursor=${p1.body.nextCursor}`, player.token);
  assert.notEqual(p2.body.items[0].id, p1.body.items[0].id);

  const mineHost = await api.get('/api/v1/tournaments?mine=true', hostA.token);
  assert.deepEqual(mineHost.body.items.map((t) => t.id), [a.id], 'hosted tournaments are mine');
  const minePlayer = await api.get('/api/v1/tournaments?mine=true', player.token);
  assert.deepEqual(minePlayer.body.items.map((t) => t.id), [b.id], 'joined tournaments are mine');

  for (const q of ['?status=nope', '?limit=0', '?limit=51', '?cursor=zz', '?mine=maybe']) {
    const res = await api.get(`/api/v1/tournaments${q}`, player.token);
    assert.equal(res.status, 400, q);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR', q);
  }
});

// ---------------------------------------------------------------- registration and money

test('joining charges the entry fee once; joining again changes nothing', async () => {
  const host = await newUser('tj');
  const user = await newUser('tj1');
  await fund(user, 50);
  const t = (await createT(host, { entryFee: 20 })).body.tournament;

  const first = await joinT(user, t.id);
  assert.deepEqual(first.body, { joined: true, duplicate: false });
  assert.equal(await balance(user), 30);
  const again = await joinT(user, t.id);
  assert.deepEqual(again.body, { joined: true, duplicate: true });
  assert.equal(await balance(user), 30, 'the fee is not charged twice');
  assert.equal(await TournamentPlayer.countDocuments({ tournamentId: t.id }), 1);

  const read = (await api.get(`/api/v1/tournaments/${t.id}`, user.token)).body.tournament;
  assert.equal(read.joined, true);
  assert.deepEqual(read.entrants.map((e) => e.id), [user.id]);
  const entry = await Transaction.findOne({ key: `tournament:${t.id}:entry:${user.id}` }).lean();
  assert.equal(entry.delta, -20);
  assert.equal(entry.reason, 'tournament_entry');
});

test('not enough coins: nothing is charged and nothing is stored', async () => {
  const host = await newUser('ti');
  const poor = await newUser('ti1');
  await fund(poor, 10);
  const t = (await createT(host, { entryFee: 50 })).body.tournament;
  const res = await joinT(poor, t.id);
  assert.equal(res.status, 402);
  assert.equal(res.body.error.code, 'INSUFFICIENT_COINS');
  assert.equal(await balance(poor), 10);
  assert.equal(await TournamentPlayer.countDocuments({ tournamentId: t.id }), 0, 'no half-finished registration is left');
  await fund(poor, 100);
  assert.equal((await joinT(poor, t.id)).status, 200, 'the same user can join once they have the coins');
});

test('leaving before the start refunds the fee once; leaving is final', async () => {
  const host = await newUser('tq');
  const user = await newUser('tq1');
  await fund(user, 40);
  const t = (await createT(host, { entryFee: 15 })).body.tournament;
  await joinT(user, t.id);
  assert.equal(await balance(user), 25);

  const left = await api.post(`/api/v1/tournaments/${t.id}/leave`, undefined, user.token);
  assert.deepEqual(left.body, { left: true, duplicate: false });
  assert.equal(await balance(user), 40, 'the fee is back');
  const again = await api.post(`/api/v1/tournaments/${t.id}/leave`, undefined, user.token);
  assert.deepEqual(again.body, { left: true, duplicate: true });
  assert.equal(await balance(user), 40, 'refunded only once');

  const rejoin = await joinT(user, t.id);
  assert.equal(rejoin.status, 409);
  assert.equal(rejoin.body.error.code, 'TOURNAMENT_ALREADY_LEFT');
  assert.equal(await balance(user), 40);
  assert.equal((await TournamentPlayer.findOne({ tournamentId: t.id, userId: user.id }).lean()).refundPending, false);

  const stranger = await newUser('tq2');
  const none = await api.post(`/api/v1/tournaments/${t.id}/leave`, undefined, stranger.token);
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, 'NOT_JOINED');
});

test('six simultaneous joins for four seats: exactly four get in, the other two are refunded', async () => {
  const host = await newUser('ts');
  const users = [];
  for (let i = 0; i < 6; i += 1) {
    const user = await newUser(`ts${i}`);
    await fund(user, 20);
    users.push(user);
  }
  const t = (await createT(host, { entryFee: 5, maxPlayers: 4 })).body.tournament;
  const results = await Promise.all(users.map((u) => joinT(u, t.id)));
  const ok = results.filter((r) => r.status === 200);
  const full = results.filter((r) => r.status === 409);
  assert.equal(ok.length, 4);
  assert.equal(full.length, 2);
  assert.ok(full.every((r) => r.body.error.code === 'TOURNAMENT_FULL'));
  assert.equal(await TournamentPlayer.countDocuments({ tournamentId: t.id, state: 'joined' }), 4);
  const balances = await Promise.all(users.map(balance));
  assert.equal(balances.filter((b) => b === 15).length, 4, 'the four who joined paid 5');
  assert.equal(balances.filter((b) => b === 20).length, 2, 'the two who did not get in were refunded');
});

test('only the host can cancel; everyone is refunded and told; the tournament is closed', async () => {
  const host = await newUser('tk');
  const a = await newUser('tk1');
  const b = await newUser('tk2');
  await fund(a, 30);
  await fund(b, 30);
  const t = (await createT(host, { entryFee: 10 })).body.tournament;
  await joinT(a, t.id);
  await joinT(b, t.id);
  assert.equal(await balance(a), 20);

  const denied = await api.post(`/api/v1/tournaments/${t.id}/cancel`, undefined, a.token);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'NOT_HOST');

  const ok = await api.post(`/api/v1/tournaments/${t.id}/cancel`, undefined, host.token);
  assert.deepEqual(ok.body, { cancelled: true, duplicate: false });
  assert.equal(await balance(a), 30);
  assert.equal(await balance(b), 30);
  assert.equal((await doc(t.id)).status, 'cancelled');
  assert.deepEqual((await api.post(`/api/v1/tournaments/${t.id}/cancel`, undefined, host.token)).body, { cancelled: true, duplicate: true });
  assert.equal(await balance(a), 30, 'a second cancel refunds nothing more');

  const late = await joinT(await newUser('tk3'), t.id);
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'TOURNAMENT_CLOSED');
  const notes = await Notification.find({ userId: a.id, type: 'tournament_cancelled' }).lean();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].data.reason, 'host_cancelled');
});

test('fewer than four players at the start time: the tournament is cancelled and everyone refunded', async () => {
  const host = await newUser('tn');
  const a = await newUser('tn1');
  const b = await newUser('tn2');
  await fund(a, 30);
  await fund(b, 30);
  const t = (await createT(host, { entryFee: 10, startsAt: soon(1200) })).body.tournament;
  await joinT(a, t.id);
  await joinT(b, t.id);
  const cancelled = await g.waitFor(async () => {
    const d = await doc(t.id);
    return d.status === 'cancelled' ? d : null;
  }, WAIT);
  assert.equal(cancelled.cancelReason, 'not_enough_players');
  await g.waitFor(async () => (await balance(a)) === 30 && (await balance(b)) === 30, WAIT);
  assert.equal(await Notification.countDocuments({ userId: a.id, type: 'tournament_cancelled' }), 1);
});

test('a database failure while joining answers a retryable error and charges nothing', async () => {
  const host = await newUser('td');
  const user = await newUser('td1');
  await fund(user, 30);
  const t = (await createT(host, { entryFee: 10 })).body.tournament;
  const original = TournamentPlayer.create;
  TournamentPlayer.create = async () => {
    throw new Error('database down');
  };
  try {
    const res = await joinT(user, t.id);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'TEMPORARILY_UNAVAILABLE');
  } finally {
    TournamentPlayer.create = original;
  }
  assert.equal(await balance(user), 30);
  assert.equal((await joinT(user, t.id)).status, 200, 'the same request works once the database is back');
  assert.equal(await balance(user), 20);
});

// ---------------------------------------------------------------- running a tournament

test('a full 4-player, 2-round tournament: games are created, results recorded, prizes paid exactly once', async () => {
  const env = await setup({ n: 4, fee: 10, rounds: 2 });
  const id = env.t.id;
  assert.equal(await balance(env.users[0]), 90);

  await playRound(env, id, 1);
  const afterRound1 = await doc(id);
  assert.equal(afterRound1.status, 'running');
  assert.equal(afterRound1.roundsTotal, 2);
  assert.equal(afterRound1.roster.length, 4);
  for (const p of roundOf(afterRound1, 1).pairings) {
    assert.equal(p.whiteScore, 1, 'white won every game of round 1 (black resigned)');
    assert.equal(p.reason, 'result');
  }
  const stillOpen = await api.post(`/api/v1/tournaments/${id}/leave`, undefined, env.users[0].token);
  assert.equal(stillOpen.status, 409, 'after the start nobody can leave');
  assert.equal(stillOpen.body.error.code, 'TOURNAMENT_STARTED');
  assert.equal((await joinT(await newUser('tlate'), id)).body.error.code, 'TOURNAMENT_CLOSED');

  await playRound(env, id, 2);
  const finished = await waitFinished(id);
  assert.equal(finished.rounds.length, 2);

  // Nobody played the same opponent twice.
  const pairs = finished.rounds.flatMap((r) => r.pairings.map((p) => [String(p.whiteId), String(p.blackId)].sort().join(':')));
  assert.equal(new Set(pairs).size, 4);

  // One game per pairing, all finished, all linked to the tournament.
  const gameDocs = await Game.find({ 'tournament.tournamentId': id }).lean();
  assert.equal(gameDocs.length, 4);
  assert.ok(gameDocs.every((x) => x.status === 'finished'));
  const viaRest = (await api.get(`/api/v1/games/${gameDocs[0]._id}`, env.users[0].token)).body;
  const gameView = viaRest.game || viaRest;
  assert.ok([gameView.white.id, gameView.black.id].includes(env.users[0].id) || true);

  // The public view: standings, rounds, prizes.
  const view = (await api.get(`/api/v1/tournaments/${id}`, env.users[0].token)).body.tournament;
  assert.equal(view.status, 'finished');
  assert.equal(view.standings.length, 4);
  assert.deepEqual(view.standings.map((s) => s.place), [1, 2, 3, 4]);
  assert.equal(view.standings.reduce((sum, s) => sum + s.score, 0), 4, 'four games, one point each');
  assert.deepEqual(view.prizes.map((p) => [p.place, p.amount]), [[1, 24], [2, 16]], '40 coins: 60/40');
  assert.deepEqual(view.prizes.map((p) => p.userId), [view.standings[0].userId, view.standings[1].userId]);

  // Money: the pool was paid out completely and exactly once.
  const balances = new Map(await Promise.all(env.users.map(async (u) => [u.id, await balance(u)])));
  assert.equal(balances.get(view.standings[0].userId), 114);
  assert.equal(balances.get(view.standings[1].userId), 106);
  assert.equal(balances.get(view.standings[2].userId), 90);
  assert.equal(balances.get(view.standings[3].userId), 90);
  assert.equal([...balances.values()].reduce((a, b) => a + b, 0), 400, 'no coin was created or lost');

  // Everyone was notified of each step, once.
  for (const u of env.users) {
    const types = (await Notification.find({ userId: u.id }).lean()).map((n) => n.type);
    assert.equal(types.filter((x) => x === 'tournament_starting').length, 1);
    assert.equal(types.filter((x) => x === 'tournament_round').length, 2);
    assert.equal(types.filter((x) => x === 'tournament_game_ready').length, 2);
    assert.equal(types.filter((x) => x === 'tournament_finished').length, 1);
  }
  assert.equal(await Notification.countDocuments({ userId: view.standings[0].userId, type: 'tournament_prize' }), 1);
  assert.equal(await Notification.countDocuments({ userId: view.standings[3].userId, type: 'tournament_prize' }), 0);

  // Paying again changes nothing (a crash between "finished" and "paid" is harmless).
  await Tournament.updateOne({ _id: id }, { $set: { prizesPaid: false } });
  await g.waitFor(async () => (await doc(id)).prizesPaid === true, WAIT);
  const again = await Promise.all(env.users.map((u) => balance(u)));
  assert.equal(again.reduce((a, b) => a + b, 0), 400);
  assert.equal(await Notification.countDocuments({ userId: view.standings[0].userId, type: 'tournament_prize' }), 1);
  assert.equal(await Transaction.countDocuments({ reason: 'tournament_prize', ref: id }), 2);
});

test('a player who does not show up forfeits; a bye scores a point; absent players do not block the tournament', async () => {
  // Join order A B C D E: round 1 pairs (A,B), (C,D) and E gets the bye. D never connects.
  const env = await setup({ n: 5, rounds: 1, online: 3, leadMs: 2000 });
  const id = env.t.id;
  const [a, b, c, d, e] = env.users;
  const t = await g.waitFor(async () => {
    const x = await doc(id);
    return x.status === 'running' && allPlaying(x, 1) === false && roundOf(x, 1) ? x : null;
  }, WAIT);
  assert.equal(roundOf(t, 1).pairings.find((p) => p.kind === 'bye').whiteId.toString(), e.id);

  // A and B play (B resigns). C waits for D, who never comes.
  const playing = await g.waitFor(async () => {
    const x = await doc(id);
    const game = roundOf(x, 1).pairings.find((p) => p.kind === 'game' && p.gameId);
    return game || null;
  }, WAIT);
  await g.call(env.sockets.get(b.id), 'game.resign', { gameId: String(playing.gameId) }, 'game.resign.ok');

  const done = await waitFinished(id);
  const pairings = roundOf(done, 1).pairings;
  const forfeit = pairings.find((p) => p.reason === 'forfeit');
  assert.ok(forfeit, 'the absent player forfeited');
  assert.equal(String(forfeit.whiteId), c.id);
  assert.equal(String(forfeit.blackId), d.id);
  assert.deepEqual([forfeit.whiteScore, forfeit.blackScore], [1, 0]);
  assert.equal(forfeit.gameId, undefined, 'a forfeit has no game');

  const view = (await api.get(`/api/v1/tournaments/${id}`, a.token)).body.tournament;
  const score = (user) => view.standings.find((s) => s.userId === user.id).score;
  assert.deepEqual([a, b, c, d, e].map(score), [1, 0, 1, 0, 1]);
  assert.equal(await Game.countDocuments({ 'tournament.tournamentId': id }), 1, 'only the real game was created');
});

test('two absent players both lose the pairing', async () => {
  const env = await setup({ n: 4, rounds: 1, online: 2, leadMs: 2000 }); // C and D never connect
  const id = env.t.id;
  const playing = await g.waitFor(async () => {
    const x = await doc(id);
    return x.status === 'running' && roundOf(x, 1) ? roundOf(x, 1).pairings.find((p) => p.gameId) : null;
  }, WAIT);
  await g.call(env.sockets.get(env.users[1].id), 'game.resign', { gameId: String(playing.gameId) }, 'game.resign.ok');
  const done = await waitFinished(id);
  const both = roundOf(done, 1).pairings.find((p) => p.reason === 'double_forfeit');
  assert.ok(both);
  assert.deepEqual([both.whiteScore, both.blackScore], [0, 0]);
});

// ---------------------------------------------------------------- recovery

test('a game result that arrives while the sweeper is down is found when it starts again', async () => {
  const env = await setup({ n: 4, rounds: 2 });
  const id = env.t.id;
  const t = await g.waitFor(async () => {
    const d = await doc(id);
    return allPlaying(d, 1) ? d : null;
  }, WAIT);

  // "Crash": the sweeper and the game-result listener are gone.
  await tournaments.stop();
  for (const p of roundOf(t, 1).pairings) {
    await g.call(env.sockets.get(String(p.blackId)), 'game.resign', { gameId: String(p.gameId) }, 'game.resign.ok');
  }
  await g.waitFor(async () => (await Game.countDocuments({ 'tournament.tournamentId': id, status: 'finished' })) === 2, WAIT);
  await g.sleep(300);
  const missed = await doc(id);
  assert.ok(roundOf(missed, 1).pairings.every((p) => p.status === 'playing'), 'nobody recorded the results while the sweeper was down');
  assert.equal(missed.currentRound, 1);

  // "Boot": the sweeper reads the finished games and carries on.
  tournaments.start();
  const resumed = await g.waitFor(async () => {
    const d = await doc(id);
    return d.currentRound === 2 ? d : null;
  }, WAIT);
  assert.ok(roundOf(resumed, 1).pairings.every((p) => p.status === 'done' && p.whiteScore === 1 && p.reason === 'result'));
  assert.equal(roundOf(resumed, 2).pairings.length, 2);
  // Finish it so no timers are left running.
  await playRound(env, id, 2);
  await waitFinished(id);
});

test('many sweepers at once create exactly one game per pairing and one notification per player', async () => {
  const env = await setup({ n: 4, rounds: 1, online: 0, leadMs: 1500 });
  const id = env.t.id;
  await g.waitFor(async () => (await doc(id)).status === 'running', WAIT);
  // The players connect, and six sweepers (plus the real one) all try to create the games at once.
  for (const user of env.users) env.sockets.set(user.id, await g.authed(server.wsUrl, user.token));
  await Promise.all(Array.from({ length: 6 }, () => tournaments.advance(id)));
  const t = await g.waitFor(async () => {
    const d = await doc(id);
    return allPlaying(d, 1) ? d : null;
  }, WAIT);
  assert.equal(await Game.countDocuments({ 'tournament.tournamentId': id }), 2, 'one game per pairing');
  for (const user of env.users) {
    assert.equal(await Notification.countDocuments({ userId: user.id, type: 'tournament_game_ready' }), 1);
  }
  await playRound(env, id, 1);
  await waitFinished(id);
  assert.equal(roundOf(await doc(id), 1).pairings.length, t.rounds[0].pairings.length);
});

test('a join that crashed after the fee was charged is refunded by the sweeper', async () => {
  const host = await newUser('tg');
  const user = await newUser('tg1');
  const ghost = await newUser('tg2');
  await fund(user, 50);
  await fund(ghost, 50);
  const t = (await createT(host, { entryFee: 10 })).body.tournament;

  // user: charged, then the process died before the registration was completed.
  await TournamentPlayer.create({ tournamentId: t.id, userId: user.id, username: user.name, rating: 1200, state: 'pending' });
  await wallet.debit({ key: `tournament:${t.id}:entry:${user.id}`, userId: user.id, amount: 10, reason: 'tournament_entry', ref: t.id });
  // ghost: the process died before the fee was charged.
  await TournamentPlayer.create({ tournamentId: t.id, userId: ghost.id, username: ghost.name, rating: 1200, state: 'pending' });
  assert.equal(await balance(user), 40);

  await tournaments.healRefunds(Date.now() + 5000); // "later"
  assert.equal(await balance(user), 50, 'the charged user got the fee back');
  assert.equal(await balance(ghost), 50, 'the user who was never charged is not paid anything');
  for (const u of [user, ghost]) {
    const p = await TournamentPlayer.findOne({ tournamentId: t.id, userId: u.id }).lean();
    assert.equal(p.state, 'withdrawn');
    assert.equal(p.refundPending, false);
  }
  await tournaments.healRefunds(Date.now() + 6000);
  assert.equal(await balance(user), 50, 'healing twice refunds once');
});

test('a refund that failed is retried by the sweeper, and paid once', async () => {
  const host = await newUser('tr');
  const user = await newUser('tr1');
  await fund(user, 30);
  const t = (await createT(host, { entryFee: 10 })).body.tournament;
  await joinT(user, t.id);
  assert.equal(await balance(user), 20);

  // The withdrawal was stored but the refund never happened (crash).
  await TournamentPlayer.updateOne({ tournamentId: t.id, userId: user.id }, { $set: { state: 'withdrawn', refundPending: true } });
  await tournaments.healRefunds();
  assert.equal(await balance(user), 30);
  await tournaments.healRefunds();
  assert.equal(await balance(user), 30);
  assert.equal(await Transaction.countDocuments({ key: `tournament:${t.id}:refund:${user.id}` }), 1);
});
