'use strict';

// Shared helpers for the game tests. Not a test file (the name does not match *.test.js).
// Test files must set process.env.GAME_* overrides BEFORE requiring this file or ./helpers.
const h = require('./helpers');

let counter = 0;
const opened = [];

/** Short unique alphanumeric username. */
function uniq(prefix) {
  counter += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${counter}`.slice(0, 20);
}

async function authed(wsUrl, token) {
  const socket = await h.authedSocket(wsUrl, token);
  opened.push(socket);
  return socket;
}

function closeAll() {
  for (const socket of opened.splice(0)) socket.terminate();
}

/** Sends an event and resolves with the reply payload (matched by id). Throws Error(code) on a protocol error. */
async function call(socket, type, payload, okType, timeoutMs = 3000) {
  counter += 1;
  const id = `c${counter}`;
  socket.send(JSON.stringify({ id, type, payload }));
  const skipped = [];
  const end = Date.now() + timeoutMs;
  for (;;) {
    const msg = await socket.next(Math.max(50, end - Date.now()));
    if (msg.id !== id) {
      skipped.push(msg);
      continue;
    }
    socket.requeue(skipped);
    if (msg.type === 'error') {
      const err = new Error(msg.payload.code);
      err.code = msg.payload.code;
      throw err;
    }
    if (okType && msg.type !== okType) throw new Error(`expected ${okType}, got ${msg.type}`);
    return msg.payload;
  }
}

/** Resolves with the error code of a call that must fail. */
async function errorOf(socket, type, payload) {
  try {
    await call(socket, type, payload);
  } catch (err) {
    if (err.code) return err.code;
    throw err;
  }
  throw new Error(`${type} was expected to fail but succeeded`);
}

/** Sends without waiting; returns the request id. */
function raw(socket, type, payload) {
  counter += 1;
  const id = `r${counter}`;
  socket.send(JSON.stringify({ id, type, payload }));
  return id;
}

// Scripted opening: the server does not check legality (D-021), only turn, seq and the FEN side to move.
const MOVES = [
  { uci: 'e2e4', san: 'e4', fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' },
  { uci: 'e7e5', san: 'e5', fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' },
  { uci: 'g1f3', san: 'Nf3', fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2' },
  { uci: 'b8c6', san: 'Nc6', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3' },
];

/** Payload for scripted move `i`; `tag` makes a different moveId for the same move. */
function moveMsg(gameId, i, extra = {}) {
  const m = MOVES[i];
  return { gameId, moveId: `mv${i}${extra.tag || ''}-${gameId.slice(-10)}`, seq: i, uci: m.uci, san: m.san, fen: m.fen, ...extra.fields };
}

const sleep = h.sleep;

async function waitFor(fn, timeoutMs = 3000, stepMs = 25) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(stepMs);
  }
}

/**
 * Registers two users, connects them and matches them through the queue.
 * Returns { white, black, gameId } where each side is { user, socket }.
 */
async function startMatch(ctx, api, { timeControl = '5+0', rated = true } = {}) {
  const a = await h.registerUser(api, uniq('pa'));
  const b = await h.registerUser(api, uniq('pb'));
  const sa = await authed(ctx.wsUrl, a.token);
  const sb = await authed(ctx.wsUrl, b.token);
  await call(sa, 'queue.join', { timeControl, rated }, 'queue.joined');
  await call(sb, 'queue.join', { timeControl, rated }, 'queue.joined');
  const startedA = await sa.nextOfType('game.started');
  await sb.nextOfType('game.started');
  const a2 = { user: a, socket: sa };
  const b2 = { user: b, socket: sb };
  const aIsWhite = startedA.payload.yourColor === 'w';
  return {
    gameId: startedA.payload.game.id,
    white: aIsWhite ? a2 : b2,
    black: aIsWhite ? b2 : a2,
  };
}

module.exports = { uniq, authed, closeAll, call, errorOf, raw, MOVES, moveMsg, sleep, waitFor, startMatch };
