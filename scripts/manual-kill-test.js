'use strict';

/**
 * Manual failure test: kill the server in the middle of a live game (FAILURE_RECOVERY_GUIDE.md).
 *
 * Run:   node scripts/manual-kill-test.js
 *
 * It starts its OWN copy of the server on port 3100, plays two moves between two new test players,
 * kills the server process with no warning (a real hard kill, like a crash), waits, starts the
 * server again and checks what the players see. Your normal server must be stopped first
 * (it would remove the test players from the matchmaking queue).
 *
 * It uses the database from your .env and creates two test users (names start with "kt").
 * It never deletes anything. Environment overrides for experts: TEST_PORT, DOWNTIME_MS.
 */
require('dotenv').config({ quiet: true });
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TEST_PORT = Number(process.env.TEST_PORT || 3100);
const DOWNTIME_MS = Number(process.env.DOWNTIME_MS || 12000);
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`;

const MOVE_1 = { uci: 'e2e4', san: 'e4', fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1' };
const MOVE_2 = { uci: 'e7e5', san: 'e5', fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function step(text) {
  console.log(`\n== ${text}`);
}

function check(ok, text, detail) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${text}${!ok && detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------- the server process

let server = null;
let serverOutput = '';

function startServer() {
  serverOutput = '';
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (serverOutput += d.toString()));
  server.stderr.on('data', (d) => (serverOutput += d.toString()));
  server.exitInfo = new Promise((resolve) => server.once('exit', (code) => resolve(code)));
}

async function waitReady(timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (server.exitCode !== null) throw new Error('The server stopped by itself. Its output:\n' + serverOutput.slice(-1500));
    try {
      const res = await fetch(`${BASE}/health/ready`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(300);
  }
  throw new Error('The server did not become ready in time. Its output:\n' + serverOutput.slice(-1500));
}

async function killServer() {
  // On Windows any signal is a forced termination: no cleanup code runs, like a real crash.
  server.kill('SIGKILL');
  await server.exitInfo;
}

// ---------------------------------------------------------------- a tiny WebSocket client

let requestCounter = 0;

class Client {
  constructor(name) {
    this.name = name;
    this.messages = [];
  }

  async login(token) {
    this.ws = new WebSocket(WS_URL);
    this.ws.on('message', (data) => this.messages.push(JSON.parse(data.toString())));
    this.ws.on('error', () => {});
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    await this.waitFor((m) => m.type === 'server.hello');
    this.ws.send(JSON.stringify({ id: 'auth', type: 'auth', payload: { accessToken: token } }));
    await this.waitFor((m) => m.type === 'auth.ok');
  }

  async waitFor(match, timeoutMs = 8000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const index = this.messages.findIndex(match);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      if (Date.now() > end) throw new Error(`${this.name}: timed out waiting for a message`);
      await sleep(25);
    }
  }

  /** Sends an event and returns the payload of the reply. Throws on a server error. */
  async request(type, payload) {
    requestCounter += 1;
    const id = `r${requestCounter}`;
    this.ws.send(JSON.stringify({ id, type, payload }));
    const reply = await this.waitFor((m) => m.id === id);
    if (reply.type === 'error') throw new Error(`${type} was refused: ${reply.payload.code}`);
    return reply.payload;
  }

  close() {
    try {
      this.ws.terminate();
    } catch {
      // already closed
    }
  }
}

async function register(name) {
  const res = await fetch(`${BASE}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.com`, username: name, password: `${name}-Passw0rd!` }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Could not register ${name}: ${JSON.stringify(body)}`);
  return { id: body.user.id, token: body.accessToken };
}

async function gameViaRest(gameId, token) {
  const res = await fetch(`${BASE}/api/v1/games/${gameId}`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()).game;
}

// ---------------------------------------------------------------- the test

async function main() {
  step('0. Checking that your normal server is not running');
  const normalPort = Number(process.env.PORT || 3000);
  if (normalPort !== TEST_PORT) {
    const running = await fetch(`http://127.0.0.1:${normalPort}/health/live`, { signal: AbortSignal.timeout(1500) })
      .then(() => true)
      .catch(() => false);
    if (running) {
      console.log(`   Your normal server is running on port ${normalPort}.`);
      console.log('   Click its terminal tab, press Ctrl+C to stop it, then run this script again.');
      process.exit(2);
    }
  }
  console.log('   OK');

  const tag = Math.random().toString(36).slice(2, 8);
  const clients = [];
  try {
    step('1. Starting the server (copy 1) and two test players');
    startServer();
    await waitReady();
    const userA = await register(`kt${tag}a`);
    const userB = await register(`kt${tag}b`);
    const a = new Client('player A');
    const b = new Client('player B');
    clients.push(a, b);
    await a.login(userA.token);
    await b.login(userB.token);
    console.log('   Both players are connected.');

    step('2. Matchmaking: both join the 5+0 casual queue');
    await a.request('queue.join', { timeControl: '5+0', rated: false });
    await b.request('queue.join', { timeControl: '5+0', rated: false });
    const startedA = await a.waitFor((m) => m.type === 'game.started');
    await b.waitFor((m) => m.type === 'game.started');
    const gameId = startedA.payload.game.id;
    const aIsWhite = startedA.payload.yourColor === 'w';
    const white = { client: aIsWhite ? a : b, user: aIsWhite ? userA : userB, name: aIsWhite ? 'player A' : 'player B' };
    const black = { client: aIsWhite ? b : a, user: aIsWhite ? userB : userA, name: aIsWhite ? 'player B' : 'player A' };
    console.log(`   Game created. White is ${white.name}, black is ${black.name}.`);

    step('3. Two moves are played and acknowledged');
    const base = { gameId };
    const ack1 = await white.client.request('game.move', { ...base, moveId: `kt-${tag}-0001`, seq: 0, ...MOVE_1 });
    check(ack1.seq === 1 && ack1.duplicate === false, 'White\'s move e4 was acknowledged (seq 1)');
    const moveTwo = { ...base, moveId: `kt-${tag}-0002`, seq: 1, ...MOVE_2 };
    const ack2 = await black.client.request('game.move', moveTwo);
    check(ack2.seq === 2 && ack2.duplicate === false, 'Black\'s move e5 was acknowledged (seq 2)');
    console.log(`   Clocks at the last ack: white ${ack2.clocks.whiteMs} ms, black ${ack2.clocks.blackMs} ms`);

    step('4. KILLING the server with no warning');
    await killServer();
    clients.forEach((c) => c.close());
    console.log('   The server process was terminated. Both players lost their connection.');

    step(`5. Server is down for ${Math.round(DOWNTIME_MS / 1000)} seconds (this time must NOT be charged to anyone)`);
    for (let left = Math.round(DOWNTIME_MS / 1000); left > 0; left -= 1) {
      process.stdout.write(`   ${left}... `);
      await sleep(1000);
    }
    console.log('');

    step('6. Starting the server again (copy 2): boot recovery');
    startServer();
    await waitReady();
    const end = Date.now() + 15000;
    while (!serverOutput.includes('game recovery finished') && Date.now() < end) await sleep(100);
    const line = serverOutput.split('\n').find((l) => l.includes('game recovery finished'));
    let recovered = -1;
    try {
      recovered = JSON.parse(line).games;
    } catch {
      // line missing
    }
    check(recovered >= 1, 'Boot recovery found the interrupted game', `log says games=${recovered}`);

    step('7. The first player reconnects and asks for the game state');
    const w2 = new Client(white.name);
    clients.push(w2);
    await w2.login(white.user.token);
    const active = await w2.waitFor((m) => m.type === 'game.active');
    check(active.payload.gameId === gameId, 'The server announces the interrupted game (game.active)');
    const state = (await w2.request('game.join', { gameId })).game;
    check(state.status === 'paused_server_recovery', 'The game is paused because of the server outage', `status=${state.status}`);
    check(state.seq === 2 && state.moves.length === 2, 'Both moves are still there (seq 2)', `seq=${state.seq}, moves=${state.moves && state.moves.length}`);
    check(state.clocks.running === false, 'The clocks are stopped while paused');
    const whiteLost = ack2.clocks.whiteMs - state.clocks.whiteMs;
    check(
      whiteLost >= 0 && whiteLost < 7000,
      `White's clock was NOT reduced by the ${Math.round(DOWNTIME_MS / 1000)} s outage`,
      `white lost ${whiteLost} ms`
    );
    check(state.clocks.blackMs === ack2.clocks.blackMs, "Black's clock is unchanged");
    console.log(`   Clocks now: white ${state.clocks.whiteMs} ms, black ${state.clocks.blackMs} ms`);

    step('8. The second player reconnects: play must resume only now');
    const b2 = new Client(black.name);
    clients.push(b2);
    await b2.login(black.user.token);
    await w2.waitFor((m) => m.type === 'game.resumed');
    check(true, 'Both players are back, so the server resumed the game (game.resumed)');
    await sleep(1200);
    const live = await gameViaRest(gameId, white.user.token);
    check(live.status === 'active' && live.clocks.running === true, 'The game is active and the clock of the side to move is running');
    check(live.clocks.whiteMs < state.clocks.whiteMs, "White's clock is counting down again (white is to move)");

    step('9. Lost acknowledgement: black sends the same move again');
    await b2.request('game.join', { gameId });
    const again = await b2.request('game.move', moveTwo);
    check(again.duplicate === true && again.seq === 2, 'The server recognised the move and did not apply it twice (duplicate: true)');
    const finalGame = await gameViaRest(gameId, black.user.token);
    check(finalGame.moves.length === 2, 'The game still has exactly 2 moves', `moves=${finalGame.moves.length}`);
  } finally {
    clients.forEach((c) => c.close());
    if (server && server.exitCode === null) await killServer();
  }

  console.log('\n' + (failures === 0 ? 'RESULT: ALL CHECKS PASSED' : `RESULT: ${failures} CHECK(S) FAILED. Copy everything above and send it to me.`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`\nThe test stopped with an error: ${err.message}`);
  if (server && server.exitCode === null) await killServer().catch(() => {});
  process.exit(1);
});
