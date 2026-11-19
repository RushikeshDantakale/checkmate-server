'use strict';

/**
 * Temporary match chat (D-032). Relayed in RAM between the two players of a LIVE game and never
 * stored anywhere. After a restart or the end of the game it is simply gone, by design
 * (failure scenario 20). The opponent being offline means the message is dropped (`delivered: false`).
 *
 * If either player has blocked the other, the message is silently not delivered (the sender
 * still gets an ok, so a block is not revealed). See D-034.
 */
const crypto = require('node:crypto');
const { withDb } = require('../../utils/db');
const registry = require('../../websocket/registry');
const livePlayers = require('../games/livePlayers');
const friends = require('../friends/friends.service');

async function sendMatchChat(userId, { gameId, text }, fromSocket) {
  const { opponentId } = await livePlayers.requireLivePlayer(gameId, userId); // 404 / 409 GAME_OVER
  const messageId = crypto.randomUUID();
  const at = Date.now();

  const blocked = await withDb(() => friends.isBlockedEitherWay(userId, opponentId), 'match chat block check');
  if (blocked) return { gameId, messageId, at, delivered: false };

  const payload = { gameId, messageId, from: String(userId), text, at };
  const delivered = registry.sendToUser(opponentId, 'chat.match.message', payload) > 0;
  registry.sendToUser(userId, 'chat.match.message', payload, fromSocket); // the sender's other devices
  return { gameId, messageId, at, delivered };
}

module.exports = { sendMatchChat };
