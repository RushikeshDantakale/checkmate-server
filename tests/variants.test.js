'use strict';

// Game variants (D-062): standard, dice, chess960 - through the queue and through friend invitations.
process.env.GAME_RECONNECT_GRACE_MS = '400';
process.env.GAME_PAUSED_HOLD_MS = '3000';
process.env.MATCH_TICK_MS = '50';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const { Game, User, MatchmakingEntry } = require('../src/database/models');
const { isValidVariant, randomChess960Fen, VARIANTS, DEFAULT_VARIANT } = require('../src/modules/games/variants');

const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

async function player() {
  const user = await h.registerUser(api, g.uniq('vr'));
  const socket = await g.authed(server.wsUrl, user.token);
  return { user, socket };
}

async function befriend(a, b) {
  const first = await api.post('/api/v1/friends/requests', { username: b.user.name }, a.user.token);
  assert.ok([200, 201].includes(first.status));
  const second = await api.post('/api/v1/friends/requests', { username: a.user.name }, b.user.token);
  assert.ok([200, 201].includes(second.status));
}

/** Two players join the queue with the same settings; resolves with both `game.started` payloads. */
async function queueMatch(extra = {}) {
  const a = await player();
  const b = await player();
  await g.call(a.socket, 'queue.join', { timeControl: '5+0', ...extra }, 'queue.joined');
  await g.call(b.socket, 'queue.join', { timeControl: '5+0', ...extra }, 'queue.joined');
  const startedA = await a.socket.nextOfType('game.started');
  const startedB = await b.socket.nextOfType('game.started');
  return { a, b, startedA: startedA.payload, startedB: startedB.payload };
}

/** A Chess960 position is valid when: one king between two rooks, opposite-colour bishops, 1 queen, 2 knights. */
function assertValidChess960(fen) {
  const [board, side, castling, ep, half, full] = fen.split(' ');
  assert.equal(side, 'w');
  assert.equal(castling, 'KQkq');
  assert.equal(ep, '-');
  assert.equal(half, '0');
  assert.equal(full, '1');
  const ranks = board.split('/');
  assert.equal(ranks.length, 8);
  const black = ranks[0];
  assert.match(black, /^[bknqr]{8}$/);
  assert.equal(ranks[1], 'pppppppp');
  assert.deepEqual(ranks.slice(2, 6), ['8', '8', '8', '8']);
  assert.equal(ranks[6], 'PPPPPPPP');
  assert.equal(ranks[7], black.toUpperCase(), 'white mirrors black');
  const count = (c) => black.split('').filter((x) => x === c).length;
  assert.equal(count('k'), 1);
  assert.equal(count('q'), 1);
  assert.equal(count('r'), 2);
  assert.equal(count('b'), 2);
  assert.equal(count('n'), 2);
  const king = black.indexOf('k');
  const rooks = [...black].flatMap((c, i) => (c === 'r' ? [i] : []));
  assert.ok(rooks[0] < king && king < rooks[1], 'king stands between the rooks');
  const bishops = [...black].flatMap((c, i) => (c === 'b' ? [i] : []));
  assert.notEqual(bishops[0] % 2, bishops[1] % 2, 'bishops on opposite colours');
}

// ---------------------------------------------------------------- unit

test('variant list, default and validation', () => {
  assert.deepEqual(VARIANTS, ['standard', 'dice', 'chess960']);
  assert.equal(DEFAULT_VARIANT, 'standard');
  assert.equal(isValidVariant('dice'), true);
  assert.equal(isValidVariant('crazyhouse'), false);
  assert.equal(isValidVariant(undefined), false);
});

test('randomChess960Fen always gives a legal Chess960 start and not always the same one', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const fen = randomChess960Fen();
    assertValidChess960(fen);
    seen.add(fen);
  }
  assert.ok(seen.size > 50, `expected many different positions, got ${seen.size}`);
});

// ---------------------------------------------------------------- queue

test('a game without a variant is a standard game and says where it started', async () => {
  const m = await g.startMatch(server, api);
  const game = await Game.findById(m.gameId).lean();
  assert.equal(game.variant, 'standard');
  const state = await g.call(m.white.socket, 'game.join', { gameId: m.gameId }, 'game.state');
  assert.equal(state.game.variant, 'standard');
  assert.equal(state.game.startFen, STANDARD_FEN);
  assert.equal(state.game.fen, STANDARD_FEN);
});

test('dice players are matched, the game is unrated and says it is a dice game', async () => {
  const { a, b, startedA, startedB } = await queueMatch({ variant: 'dice', rated: true });
  assert.equal(startedA.game.variant, 'dice');
  assert.equal(startedB.game.variant, 'dice');
  assert.equal(startedA.game.rated, false, 'a variant is never rated, even when rated was asked');
  assert.equal(startedA.game.startFen, STANDARD_FEN);
  assert.equal(startedA.game.fen, STANDARD_FEN);
  assert.notEqual(startedA.yourColor, startedB.yourColor);
  assert.equal(startedA.game.id, startedB.game.id);
  const stored = await Game.findById(startedA.game.id).lean();
  assert.equal(stored.variant, 'dice');
  assert.equal(stored.rated, false);
  assert.ok(a.socket && b.socket);
});

test('queue.joined reports the variant, and a variant forces rated to false', async () => {
  const a = await player();
  const joined = await g.call(a.socket, 'queue.join', { timeControl: '3+0', variant: 'chess960', rated: true }, 'queue.joined');
  assert.equal(joined.variant, 'chess960');
  assert.equal(joined.rated, false);
  const entry = await MatchmakingEntry.findOne({ userId: a.user.id }).lean();
  assert.equal(entry.variant, 'chess960');
  assert.equal(entry.rated, false);
  await g.call(a.socket, 'queue.leave', {}, 'queue.left');

  const plain = await g.call(a.socket, 'queue.join', { timeControl: '3+0' }, 'queue.joined');
  assert.equal(plain.variant, 'standard');
  assert.equal(plain.rated, true);
  await g.call(a.socket, 'queue.leave', {}, 'queue.left');
});

test('players who ask for different variants are not matched with each other', async () => {
  const a = await player();
  const b = await player();
  const c = await player();
  await g.call(a.socket, 'queue.join', { timeControl: '5+0', variant: 'dice', rated: false }, 'queue.joined');
  await g.call(b.socket, 'queue.join', { timeControl: '5+0', variant: 'chess960', rated: false }, 'queue.joined');
  await g.call(c.socket, 'queue.join', { timeControl: '5+0', rated: false }, 'queue.joined'); // standard, casual
  assert.equal(await a.socket.quietFor(300), true);
  assert.equal(await b.socket.quietFor(100), true);
  assert.equal(await c.socket.quietFor(100), true);
  for (const p of [a, b, c]) await g.call(p.socket, 'queue.leave', {}, 'queue.left');
});

test('chess960: both players get the same shuffled start position, which is also stored', async () => {
  const { a, b, startedA, startedB } = await queueMatch({ variant: 'chess960' });
  assert.equal(startedA.game.variant, 'chess960');
  assertValidChess960(startedA.game.startFen);
  assert.equal(startedA.game.fen, startedA.game.startFen);
  assert.equal(startedB.game.startFen, startedA.game.startFen);
  assert.equal(startedB.game.fen, startedA.game.fen);

  const stored = await Game.findById(startedA.game.id).lean();
  assert.equal(stored.startFen, startedA.game.startFen);
  assert.equal(stored.fen, startedA.game.startFen);

  // After a move and a reconnect the client still learns the start position: it needs it to replay the moves.
  const white = startedA.yourColor === 'w' ? a : b;
  await g.call(white.socket, 'game.move', g.moveMsg(startedA.game.id, 0), 'game.move.ack');
  const rejoined = await g.call(white.socket, 'game.join', { gameId: startedA.game.id }, 'game.state');
  assert.equal(rejoined.game.startFen, startedA.game.startFen);
  assert.equal(rejoined.game.moves.length, 1);
  assert.notEqual(rejoined.game.fen, rejoined.game.startFen, 'fen is the current position, startFen stays');
});

test('two chess960 games do not all start from the same position', async () => {
  const fens = new Set();
  for (let i = 0; i < 4; i += 1) {
    const { startedA } = await queueMatch({ variant: 'chess960' });
    fens.add(startedA.game.startFen);
  }
  assert.ok(fens.size > 1);
});

test('an unknown variant is rejected before anything happens', async () => {
  const a = await player();
  const b = await player();
  assert.equal(await g.errorOf(a.socket, 'queue.join', { timeControl: '5+0', variant: 'crazyhouse' }), 'INVALID_PAYLOAD');
  assert.equal(await MatchmakingEntry.countDocuments({ userId: a.user.id }), 0);
  await befriend(a, b);
  assert.equal(
    await g.errorOf(a.socket, 'invite.send', { userId: b.user.id, timeControl: '5+0', variant: 'atomic' }),
    'INVALID_PAYLOAD'
  );
});

// ---------------------------------------------------------------- invitations

test('a chess960 invitation carries the variant to both players and starts from one shuffled position', async () => {
  const a = await player();
  const b = await player();
  await befriend(a, b);
  const sent = await g.call(
    a.socket,
    'invite.send',
    { userId: b.user.id, timeControl: '3+2', rated: true, variant: 'chess960' },
    'invite.sent'
  );
  const received = await b.socket.nextOfType('invite.received');
  assert.equal(received.payload.inviteId, sent.inviteId);
  assert.equal(received.payload.variant, 'chess960');
  assert.equal(received.payload.rated, false, 'a variant invitation is always unrated');

  await g.call(b.socket, 'invite.accept', { inviteId: sent.inviteId }, 'invite.accepted');
  const startedA = (await a.socket.nextOfType('game.started')).payload;
  const startedB = (await b.socket.nextOfType('game.started')).payload;
  for (const started of [startedA, startedB]) {
    assert.equal(started.game.variant, 'chess960');
    assert.equal(started.game.rated, false);
    assert.equal(started.game.timeControl.id, '3+2');
    assertValidChess960(started.game.startFen);
    assert.equal(started.game.fen, started.game.startFen);
  }
  assert.equal(startedA.game.startFen, startedB.game.startFen);
});

test('a dice invitation works, and an invitation without a variant stays a normal game', async () => {
  const a = await player();
  const b = await player();
  await befriend(a, b);
  const dice = await g.call(a.socket, 'invite.send', { userId: b.user.id, timeControl: '5+0', variant: 'dice' }, 'invite.sent');
  assert.equal((await b.socket.nextOfType('invite.received')).payload.variant, 'dice');
  await g.call(b.socket, 'invite.accept', { inviteId: dice.inviteId }, 'invite.accepted');
  const startedDice = (await a.socket.nextOfType('game.started')).payload;
  assert.equal(startedDice.game.variant, 'dice');
  await b.socket.nextOfType('game.started');
  await g.call(a.socket, 'game.resign', { gameId: startedDice.game.id }, 'game.resign.ok');

  // A client that does not know about variants (omits the field) still gets a standard game.
  await g.sleep(150);
  const plain = await g.call(a.socket, 'invite.send', { userId: b.user.id, timeControl: '5+0' }, 'invite.sent');
  const received = await b.socket.nextOfType('invite.received');
  assert.equal(received.payload.variant, 'standard');
  await g.call(b.socket, 'invite.accept', { inviteId: plain.inviteId }, 'invite.accepted');
  const startedPlain = (await a.socket.nextOfType('game.started')).payload;
  assert.equal(startedPlain.game.variant, 'standard');
  assert.equal(startedPlain.game.startFen, STANDARD_FEN);
});

// ---------------------------------------------------------------- results

test('a finished chess960 game keeps its start position in the PGN and changes no ratings', async () => {
  const { a, b, startedA } = await queueMatch({ variant: 'chess960' });
  const white = startedA.yourColor === 'w' ? a : b;
  const black = white === a ? b : a;
  const outcome = { result: '1-0', reason: 'checkmate' };
  const ack = await g.call(white.socket, 'game.move', g.moveMsg(startedA.game.id, 0, { fields: { outcome } }), 'game.move.ack');
  assert.equal(ack.status, 'finished');
  const over = (await white.socket.nextOfType('game.over')).payload;
  assert.match(over.pgn, /\[Variant "Chess960"\]/);
  assert.match(over.pgn, /\[SetUp "1"\]/);
  assert.ok(over.pgn.includes(`[FEN "${startedA.game.startFen}"]`));
  assert.ok(!over.ratingChange, 'an unrated game has no rating change');
  assert.equal((await User.findById(white.user.id).lean()).rating, 1200);
  assert.equal((await User.findById(black.user.id).lean()).rating, 1200);

  // The same data is available over REST for the history screen.
  const rest = await api.get(`/api/v1/games/${startedA.game.id}`, white.user.token);
  assert.equal(rest.body.game.variant, 'chess960');
  assert.equal(rest.body.game.startFen, startedA.game.startFen);
});

test('a finished dice game is labelled in the PGN and has no SetUp or FEN header', async () => {
  const { a, b, startedA } = await queueMatch({ variant: 'dice' });
  const white = startedA.yourColor === 'w' ? a : b;
  const outcome = { result: '1-0', reason: 'checkmate' };
  await g.call(white.socket, 'game.move', g.moveMsg(startedA.game.id, 0, { fields: { outcome } }), 'game.move.ack');
  const over = (await white.socket.nextOfType('game.over')).payload;
  assert.match(over.pgn, /\[Variant "Dice Chess"\]/);
  assert.doesNotMatch(over.pgn, /\[SetUp /);
  assert.doesNotMatch(over.pgn, /\[FEN /);
});
