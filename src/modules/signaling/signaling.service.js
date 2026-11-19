'use strict';

/**
 * WebRTC signaling for 1-vs-1 match voice (D-027, D-033). This server only RELAYS the offer,
 * answer and ICE candidates between the two players of a live game; audio never passes through
 * it and nothing is stored. One RAM record per call (by game id) provides:
 *   - authorization (only the two players of a live game),
 *   - glare protection (a second offer while a call exists gets VOICE_BUSY),
 *   - routing (answer and ICE go to the specific device that took part),
 *   - clean-up (peer disconnects, game ends, nobody answers in time).
 * After a reconnect or server restart the call is gone and the client simply starts it again.
 */
const config = require('../../config');
const events = require('../../utils/events');
const { AppError } = require('../../utils/errors');
const { withDb } = require('../../utils/db');
const registry = require('../../websocket/registry');
const { send } = require('../../websocket/messaging');
const livePlayers = require('../games/livePlayers');
const friends = require('../friends/friends.service');
const ice = require('../../services/iceServers');
const { Game } = require('../../database/models');
const calls = new Map(); // gameId -> { gameId, callerId, calleeId, callerConn, calleeConn, state, timer }
let started = false;

function findSocket(userId, connectionId) {
  return registry.socketsOf(userId).find((s) => s.connectionId === connectionId && s.readyState === s.OPEN) || null;
}

function peerOf(call, userId) {
  return call.callerId === String(userId) ? call.calleeId : call.callerId;
}

/** Removes the call and tells `notify` (user ids) that it ended. */
function endCall(call, reason, notify, extra = {}) {
  if (calls.get(call.gameId) !== call) return; // already ended
  calls.delete(call.gameId);
  clearTimeout(call.timer);
  for (const userId of notify) registry.sendToUser(userId, 'voice.ended', { gameId: call.gameId, reason, ...extra });
}

function requireCall(userId, gameId) {
  const call = calls.get(String(gameId));
  const me = String(userId);
  if (!call || (call.callerId !== me && call.calleeId !== me)) {
    throw new AppError(409, 'NO_CALL', 'There is no call for this game');
  }
  return call;
}

function voiceConfig(userId) {
  return ice.getIceConfig(userId);
}

async function offer(userId, { gameId, sdp }, socket) {
  const me = String(userId);
  const { opponentId } = await livePlayers.requireLivePlayer(gameId, me);
  const blocked = await withDb(() => friends.isBlockedEitherWay(me, opponentId), 'voice block check');
  if (blocked) throw new AppError(403, 'VOICE_UNAVAILABLE', 'Voice is not available with this player');

  // From here on everything is synchronous, so two simultaneous offers cannot both succeed.
  if (calls.has(gameId)) throw new AppError(409, 'VOICE_BUSY', 'A call is already being set up or in progress');
  if (!registry.isOnline(opponentId)) throw new AppError(409, 'OPPONENT_OFFLINE', 'Your opponent is not connected');

  const call = {
    gameId,
    callerId: me,
    calleeId: opponentId,
    callerConn: socket.connectionId,
    calleeConn: null,
    state: 'offering',
    timer: null,
  };
  call.timer = setTimeout(() => {
    if (calls.get(gameId) === call && call.state === 'offering') endCall(call, 'no_answer', [call.callerId, call.calleeId]);
  }, config.voice.ringTimeoutMs);
  call.timer.unref();
  calls.set(gameId, call);

  registry.sendToUser(opponentId, 'voice.offer', { gameId, from: me, sdp });
}

function answer(userId, { gameId, sdp }, socket) {
  const me = String(userId);
  const call = requireCall(me, gameId);
  if (call.calleeId !== me || call.state !== 'offering') throw new AppError(409, 'NO_CALL', 'There is no offer to answer');
  const callerSocket = findSocket(call.callerId, call.callerConn);
  if (!callerSocket) {
    endCall(call, 'peer_disconnected', [me]);
    throw new AppError(409, 'NO_CALL', 'The caller is no longer connected');
  }
  call.state = 'answered';
  call.calleeConn = socket.connectionId;
  clearTimeout(call.timer);
  send(callerSocket, 'voice.answer', { gameId, from: me, sdp });
  // The callee's other devices stop ringing.
  for (const other of registry.socketsOf(me)) {
    if (other !== socket) send(other, 'voice.ended', { gameId, reason: 'answered_elsewhere' });
  }
}

function iceCandidate(userId, { gameId, candidate }, socket) {
  const me = String(userId);
  const call = requireCall(me, gameId);
  const payload = { gameId, from: me, candidate };
  if (me === call.callerId) {
    if (call.callerConn !== socket.connectionId) throw new AppError(409, 'NO_CALL', 'This device is not part of the call');
    if (call.calleeConn) {
      const target = findSocket(call.calleeId, call.calleeConn);
      if (target) send(target, 'voice.ice', payload);
    } else {
      registry.sendToUser(call.calleeId, 'voice.ice', payload); // not answered yet: every callee device has the offer
    }
    return;
  }
  if (call.calleeConn !== socket.connectionId) throw new AppError(409, 'NO_CALL', 'This device is not part of the call');
  const target = findSocket(call.callerId, call.callerConn);
  if (target) send(target, 'voice.ice', payload);
}

function hangUp(userId, { gameId }) {
  const call = requireCall(userId, gameId);
  endCall(call, 'hangup', [peerOf(call, userId)]);
}

/** The client could not connect (ICE failed). The opponent is told; the answer says whether TURN exists at all (D-027). */
function reportFailure(userId, { gameId }) {
  const call = requireCall(userId, gameId);
  const turnAvailable = ice.turnAvailable();
  endCall(call, 'ice_failed', [peerOf(call, userId)], { turnAvailable });
  return { gameId: call.gameId, turnAvailable };
}

// ---------------------------------------------------------------- clean-up

function onSocketClosed({ userId, connectionId }) {
  for (const call of Array.from(calls.values())) {
    const isCallerDevice = call.callerId === userId && call.callerConn === connectionId;
    const isCalleeDevice = call.calleeId === userId && call.calleeConn === connectionId;
    const calleeGoneWhileRinging =
      call.state === 'offering' && call.calleeId === userId && registry.socketsOf(userId).length === 0;
    if (isCallerDevice || isCalleeDevice || calleeGoneWhileRinging) {
      endCall(call, 'peer_disconnected', [peerOf(call, userId)]);
    }
  }
}

function onGameStateChanged(game) {
  const call = calls.get(String(game._id));
  if (call && !Game.LIVE_STATUSES.includes(game.status)) {
    endCall(call, 'game_over', [call.callerId, call.calleeId]);
  }
}

function start() {
  if (started) return;
  started = true;
  events.on('socket.closed', onSocketClosed);
  events.on('game.state.changed', onGameStateChanged);
}

function stop() {
  if (!started) return;
  started = false;
  events.off('socket.closed', onSocketClosed);
  events.off('game.state.changed', onGameStateChanged);
  for (const call of calls.values()) clearTimeout(call.timer);
  calls.clear();
}

module.exports = { start, stop, voiceConfig, offer, answer, iceCandidate, hangUp, reportFailure };
