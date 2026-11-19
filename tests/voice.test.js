'use strict';

// WebRTC signaling for 1-vs-1 match voice (D-027, D-033). The server only relays offer, answer and
// ICE candidates between the two players of a live game. STUN-only configuration (no TURN).
process.env.VOICE_RING_TIMEOUT_MS = '500';
process.env.GAME_RECONNECT_GRACE_MS = '400';
process.env.GAME_PAUSED_HOLD_MS = '5000';
process.env.MATCH_TICK_MS = '50';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');

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

const SDP = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const CANDIDATE = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };

const offer = (p, gameId, sdp = SDP) => g.call(p.socket, 'voice.offer', { gameId, sdp }, 'voice.offer.ok');
const answer = (p, gameId, sdp = SDP) => g.call(p.socket, 'voice.answer', { gameId, sdp }, 'voice.answer.ok');

/** White calls black, black answers. Returns after the caller got the answer. */
async function establishCall(m) {
  await offer(m.white, m.gameId);
  await m.black.socket.nextOfType('voice.offer');
  await answer(m.black, m.gameId);
  await m.white.socket.nextOfType('voice.answer');
}

test('voice.config returns STUN servers and says TURN is not available', async () => {
  const m = await g.startMatch(server, api);
  const cfg = await g.call(m.white.socket, 'voice.config', {}, 'voice.config');
  assert.equal(cfg.turnAvailable, false);
  assert.equal(cfg.ttlSeconds, null);
  assert.equal(cfg.iceServers.length, 1);
  assert.ok(cfg.iceServers[0].urls.every((u) => u.startsWith('stun:')));
  assert.equal(JSON.stringify(cfg).includes('credential'), false, 'no credentials without TURN');
});

test('offer, answer and ICE candidates are relayed in both directions; hang-up ends the call', async () => {
  const m = await g.startMatch(server, api);
  await offer(m.white, m.gameId);
  const ringing = await m.black.socket.nextOfType('voice.offer');
  assert.equal(ringing.payload.gameId, m.gameId);
  assert.equal(ringing.payload.from, m.white.user.id);
  assert.equal(ringing.payload.sdp, SDP);

  // Candidates found before the answer reach the callee.
  await g.call(m.white.socket, 'voice.ice', { gameId: m.gameId, candidate: CANDIDATE }, 'voice.ice.ok');
  const early = await m.black.socket.nextOfType('voice.ice');
  assert.equal(early.payload.candidate.candidate, CANDIDATE.candidate);
  assert.equal(early.payload.from, m.white.user.id);

  await answer(m.black, m.gameId);
  const answered = await m.white.socket.nextOfType('voice.answer');
  assert.equal(answered.payload.from, m.black.user.id);
  assert.equal(answered.payload.sdp, SDP);

  await g.call(m.black.socket, 'voice.ice', { gameId: m.gameId, candidate: CANDIDATE }, 'voice.ice.ok');
  assert.equal((await m.white.socket.nextOfType('voice.ice')).payload.from, m.black.user.id);
  await g.call(m.white.socket, 'voice.ice', { gameId: m.gameId, candidate: { candidate: '' } }, 'voice.ice.ok'); // end of candidates
  assert.equal((await m.black.socket.nextOfType('voice.ice')).payload.candidate.candidate, '');

  await g.call(m.black.socket, 'voice.end', { gameId: m.gameId }, 'voice.end.ok');
  const ended = await m.white.socket.nextOfType('voice.ended');
  assert.equal(ended.payload.reason, 'hangup');
  assert.equal(ended.payload.gameId, m.gameId);
  // The call is gone: nothing more can be sent on it.
  assert.equal(await g.errorOf(m.white.socket, 'voice.ice', { gameId: m.gameId, candidate: CANDIDATE }), 'NO_CALL');
});

test('only the two players of a live game can use voice; strangers cannot probe a call', async () => {
  const m = await g.startMatch(server, api);
  const spy = await h.registerUser(api, g.uniq('spy'));
  const spySocket = await g.authed(server.wsUrl, spy.token);
  assert.equal(await g.errorOf(spySocket, 'voice.offer', { gameId: m.gameId, sdp: SDP }), 'GAME_NOT_FOUND');
  assert.equal(await g.errorOf(spySocket, 'voice.offer', { gameId: 'b'.repeat(24), sdp: SDP }), 'GAME_NOT_FOUND');
  assert.equal(await m.black.socket.quietFor(300), true, 'the opponent must not be rung by a stranger');

  await offer(m.white, m.gameId); // a real call now exists
  await m.black.socket.nextOfType('voice.offer');
  assert.equal(await g.errorOf(spySocket, 'voice.answer', { gameId: m.gameId, sdp: SDP }), 'NO_CALL');
  assert.equal(await g.errorOf(spySocket, 'voice.ice', { gameId: m.gameId, candidate: CANDIDATE }), 'NO_CALL');
  assert.equal(await g.errorOf(spySocket, 'voice.end', { gameId: m.gameId }), 'NO_CALL');
  assert.equal(await g.errorOf(spySocket, 'voice.failed', { gameId: m.gameId }), 'NO_CALL');
  assert.equal(await m.white.socket.quietFor(300), true, 'the stranger did not disturb the call');
});

test('voice events need authentication', async () => {
  const socket = await h.openSocket(server.wsUrl);
  await socket.next(); // server.hello
  socket.send(JSON.stringify({ id: '1', type: 'voice.offer', payload: { gameId: 'a'.repeat(24), sdp: SDP } }));
  assert.equal((await socket.next()).payload.code, 'UNAUTHENTICATED');
  socket.terminate();
});

test('answering, sending ICE or hanging up without a call gives NO_CALL; the caller cannot answer its own offer', async () => {
  const m = await g.startMatch(server, api);
  assert.equal(await g.errorOf(m.black.socket, 'voice.answer', { gameId: m.gameId, sdp: SDP }), 'NO_CALL');
  assert.equal(await g.errorOf(m.black.socket, 'voice.ice', { gameId: m.gameId, candidate: CANDIDATE }), 'NO_CALL');
  assert.equal(await g.errorOf(m.black.socket, 'voice.end', { gameId: m.gameId }), 'NO_CALL');
  await offer(m.white, m.gameId);
  await m.black.socket.nextOfType('voice.offer');
  assert.equal(await g.errorOf(m.white.socket, 'voice.answer', { gameId: m.gameId, sdp: SDP }), 'NO_CALL');
  // An answered call cannot be answered a second time.
  await answer(m.black, m.gameId);
  assert.equal(await g.errorOf(m.black.socket, 'voice.answer', { gameId: m.gameId, sdp: SDP }), 'NO_CALL');
});

test('a second offer while a call exists is refused (VOICE_BUSY)', async () => {
  const m = await g.startMatch(server, api);
  await offer(m.white, m.gameId);
  await m.black.socket.nextOfType('voice.offer');
  assert.equal(await g.errorOf(m.white.socket, 'voice.offer', { gameId: m.gameId, sdp: SDP }), 'VOICE_BUSY');
  assert.equal(await g.errorOf(m.black.socket, 'voice.offer', { gameId: m.gameId, sdp: SDP }), 'VOICE_BUSY');
});

test('both players offering at the same moment: exactly one call is created', async () => {
  const m = await g.startMatch(server, api);
  const idW = g.raw(m.white.socket, 'voice.offer', { gameId: m.gameId, sdp: SDP });
  const idB = g.raw(m.black.socket, 'voice.offer', { gameId: m.gameId, sdp: SDP });
  const take = async (socket, id) => {
    for (;;) {
      const msg = await socket.next(3000);
      if (msg.id === id) return msg;
    }
  };
  const [rw, rb] = await Promise.all([take(m.white.socket, idW), take(m.black.socket, idB)]);
  const results = [rw, rb].map((r) => (r.type === 'error' ? r.payload.code : r.type)).sort();
  assert.deepEqual(results, ['VOICE_BUSY', 'voice.offer.ok']);
});

test('an unanswered offer is cancelled after the ring timeout and a new call can be started', async () => {
  const m = await g.startMatch(server, api);
  await offer(m.white, m.gameId);
  await m.black.socket.nextOfType('voice.offer');
  const endedCaller = await m.white.socket.nextOfType('voice.ended', 3000);
  const endedCallee = await m.black.socket.nextOfType('voice.ended', 3000);
  assert.equal(endedCaller.payload.reason, 'no_answer');
  assert.equal(endedCallee.payload.reason, 'no_answer');
  await offer(m.black, m.gameId); // the other player may call now
  await m.white.socket.nextOfType('voice.offer');
});

test('an answered call does not time out', async () => {
  const m = await g.startMatch(server, api);
  await establishCall(m);
  await g.sleep(900); // longer than the 500 ms ring timeout
  await g.call(m.white.socket, 'voice.ice', { gameId: m.gameId, candidate: CANDIDATE }, 'voice.ice.ok');
  assert.equal((await m.black.socket.nextOfType('voice.ice')).payload.from, m.white.user.id);
});

test('when the peer disconnects the call is ended and the other side is told', async () => {
  const m = await g.startMatch(server, api);
  await establishCall(m);
  m.black.socket.terminate();
  const ended = await m.white.socket.nextOfType('voice.ended');
  assert.equal(ended.payload.reason, 'peer_disconnected');
  assert.equal(await g.errorOf(m.white.socket, 'voice.ice', { gameId: m.gameId, candidate: CANDIDATE }), 'NO_CALL');
});

test('the caller disconnecting while the phone rings stops the ringing', async () => {
  const m = await g.startMatch(server, api);
  await offer(m.white, m.gameId);
  await m.black.socket.nextOfType('voice.offer');
  m.white.socket.terminate();
  const ended = await m.black.socket.nextOfType('voice.ended');
  assert.equal(ended.payload.reason, 'peer_disconnected');
});

test('the call ends when the game ends', async () => {
  const m = await g.startMatch(server, api);
  await establishCall(m);
  await g.call(m.white.socket, 'game.resign', { gameId: m.gameId }, 'game.resign.ok');
  assert.equal((await m.black.socket.nextOfType('voice.ended')).payload.reason, 'game_over');
  assert.equal((await m.white.socket.nextOfType('voice.ended')).payload.reason, 'game_over');
  assert.equal(await g.errorOf(m.black.socket, 'voice.offer', { gameId: m.gameId, sdp: SDP }), 'GAME_OVER');
});

test('calling an opponent who is offline is refused', async () => {
  const m = await g.startMatch(server, api);
  m.black.socket.terminate();
  await g.sleep(150);
  assert.equal(await g.errorOf(m.white.socket, 'voice.offer', { gameId: m.gameId, sdp: SDP }), 'OPPONENT_OFFLINE');
});

test('voice is not available between players where one blocked the other', async () => {
  const m = await g.startMatch(server, api);
  const block = await api.post('/api/v1/friends/blocks', { userId: m.white.user.id }, m.black.user.token);
  assert.ok([200, 201, 204].includes(block.status), `block status ${block.status}`);
  assert.equal(await g.errorOf(m.white.socket, 'voice.offer', { gameId: m.gameId, sdp: SDP }), 'VOICE_UNAVAILABLE');
  assert.equal(await g.errorOf(m.black.socket, 'voice.offer', { gameId: m.gameId, sdp: SDP }), 'VOICE_UNAVAILABLE');
});

test('with two devices the callee rings on both; the first to answer wins and the other stops ringing', async () => {
  const m = await g.startMatch(server, api);
  const second = await g.authed(server.wsUrl, m.black.user.token);
  await offer(m.white, m.gameId);
  await m.black.socket.nextOfType('voice.offer');
  await second.nextOfType('voice.offer');
  await answer(m.black, m.gameId);
  assert.equal((await second.nextOfType('voice.ended')).payload.reason, 'answered_elsewhere');
  await m.white.socket.nextOfType('voice.answer');
  // The losing device is not part of the call and cannot inject candidates or an answer.
  assert.equal(await g.errorOf(second, 'voice.ice', { gameId: m.gameId, candidate: CANDIDATE }), 'NO_CALL');
  assert.equal(await g.errorOf(second, 'voice.answer', { gameId: m.gameId, sdp: SDP }), 'NO_CALL');
  // Candidates from the winning device reach the caller.
  await g.call(m.black.socket, 'voice.ice', { gameId: m.gameId, candidate: CANDIDATE }, 'voice.ice.ok');
  assert.equal((await m.white.socket.nextOfType('voice.ice')).payload.from, m.black.user.id);
});

test('voice.failed ends the call, tells the opponent and says whether TURN exists', async () => {
  const m = await g.startMatch(server, api);
  await establishCall(m);
  const reply = await g.call(m.black.socket, 'voice.failed', { gameId: m.gameId }, 'voice.failed.ok');
  assert.equal(reply.turnAvailable, false);
  const ended = await m.white.socket.nextOfType('voice.ended');
  assert.equal(ended.payload.reason, 'ice_failed');
  assert.equal(ended.payload.turnAvailable, false);
  // Playing on is not affected.
  const ack = await g.call(m.white.socket, 'game.move', g.moveMsg(m.gameId, 0), 'game.move.ack');
  assert.equal(ack.seq, 1);
});

test('a failed or ended call does not touch the game', async () => {
  const m = await g.startMatch(server, api);
  await establishCall(m);
  await g.call(m.white.socket, 'voice.end', { gameId: m.gameId }, 'voice.end.ok');
  const state = await g.call(m.white.socket, 'game.join', { gameId: m.gameId }, 'game.state');
  assert.equal(state.game.status, 'active');
});

test('invalid signaling payloads are rejected', async () => {
  const m = await g.startMatch(server, api);
  const bad = [
    ['voice.offer', { gameId: m.gameId }],
    ['voice.offer', { gameId: m.gameId, sdp: '' }],
    ['voice.offer', { gameId: m.gameId, sdp: 'x'.repeat(12001) }],
    ['voice.offer', { gameId: 'nope', sdp: SDP }],
    ['voice.offer', { gameId: m.gameId, sdp: 123 }],
    ['voice.ice', { gameId: m.gameId }],
    ['voice.ice', { gameId: m.gameId, candidate: 'text' }],
    ['voice.ice', { gameId: m.gameId, candidate: { candidate: 'x'.repeat(1001) } }],
    ['voice.ice', { gameId: m.gameId, candidate: { candidate: 'c', sdpMLineIndex: -1 } }],
    ['voice.end', {}],
  ];
  for (const [type, payload] of bad) {
    assert.equal(await g.errorOf(m.white.socket, type, payload), 'INVALID_PAYLOAD', `${type} ${JSON.stringify(payload).slice(0, 60)}`);
  }
  assert.equal(await m.black.socket.quietFor(300), true, 'nothing was relayed');
});

test('offers and answers are rate limited per socket (5 per 10 seconds)', async () => {
  const m = await g.startMatch(server, api);
  const ids = [];
  for (let i = 0; i < 9; i += 1) ids.push(g.raw(m.white.socket, 'voice.offer', { gameId: m.gameId, sdp: SDP }));
  const replies = new Map();
  while (replies.size < ids.length) {
    const msg = await m.white.socket.next(3000);
    if (ids.includes(msg.id)) replies.set(msg.id, msg);
  }
  const codes = [...replies.values()].map((r) => (r.type === 'error' ? r.payload.code : r.type));
  // One offer creates the call; (only if the 500 ms ring timeout fired mid-test could a second one succeed).
  const accepted = codes.filter((c) => c === 'voice.offer.ok').length;
  assert.ok(accepted >= 1 && accepted <= 2, codes.join(','));
  assert.ok(codes.filter((c) => c === 'RATE_LIMITED').length >= 3, codes.join(','));
});

test('ICE candidates are rate limited per socket (60 per 10 seconds)', async () => {
  const m = await g.startMatch(server, api);
  await establishCall(m);
  const ids = [];
  for (let i = 0; i < 75; i += 1) ids.push(g.raw(m.white.socket, 'voice.ice', { gameId: m.gameId, candidate: CANDIDATE }));
  const replies = new Map();
  while (replies.size < ids.length) {
    const msg = await m.white.socket.next(5000);
    if (ids.includes(msg.id)) replies.set(msg.id, msg);
  }
  const limited = [...replies.values()].filter((r) => r.type === 'error' && r.payload.code === 'RATE_LIMITED').length;
  assert.ok(limited >= 10, `limited: ${limited}`);
});
