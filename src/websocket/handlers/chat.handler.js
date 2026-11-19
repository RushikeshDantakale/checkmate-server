'use strict';

const { z } = require('zod');
const { send } = require('../messaging');
const { defineHandler } = require('./defineHandler');
const { cleanText } = require('../../utils/text');
const messaging = require('../../modules/messaging/messaging.service');
const matchChat = require('../../modules/messaging/matchChat.service');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
// Bound the work first (max), clean the text, then require something to remain.
const cleaned = (max) => z.string().max(max * 2).transform(cleanText).pipe(z.string().min(1).max(max));

const personalSchema = z.object({
  toUserId: objectId,
  clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, '8-64 characters: letters, digits, _ or -'),
  body: cleaned(2000),
});
const matchChatSchema = z.object({ gameId: objectId, text: cleaned(300) });
const readSchema = z.object({ conversationId: objectId });

/** Permanent personal messages and temporary match chat (D-029 to D-032). */
module.exports = {
  'message.send': {
    requireAuth: true,
    handle: defineHandler(
      personalSchema,
      async ({ socket, id, data, userId }) => {
        const result = await messaging.sendMessage(userId, data, socket);
        // Only reached after the message is stored (or was already stored, for a retry).
        send(socket, 'message.send.ok', result, id);
      },
      { rateLimit: { key: 'message.send', limit: 10, windowMs: 10000 } }
    ),
  },
  'message.read': {
    requireAuth: true,
    handle: defineHandler(readSchema, async ({ socket, id, data, userId }) => {
      send(socket, 'message.read.ok', await messaging.markRead(userId, data.conversationId, socket), id);
    }),
  },
  'chat.match.send': {
    requireAuth: true,
    handle: defineHandler(
      matchChatSchema,
      async ({ socket, id, data, userId }) => {
        send(socket, 'chat.match.send.ok', await matchChat.sendMatchChat(userId, data, socket), id);
      },
      { rateLimit: { key: 'chat.match.send', limit: 5, windowMs: 5000 } }
    ),
  },
};
