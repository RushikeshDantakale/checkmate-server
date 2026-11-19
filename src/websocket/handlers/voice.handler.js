'use strict';

const { z } = require('zod');
const { send } = require('../messaging');
const { defineHandler } = require('./defineHandler');
const signaling = require('../../modules/signaling/signaling.service');

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'must be a valid id');
const gameRef = z.object({ gameId: objectId });
// A session description is a few KB; the WebSocket frame limit (16 KB by default) still applies.
const sdp = z.string().min(1).max(12000);
const candidate = z.object({
  candidate: z.string().max(1000), // an empty string marks "end of candidates"
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(255).nullable().optional(),
  usernameFragment: z.string().max(64).nullable().optional(),
});

const sdpLimit = { key: 'voice.sdp', limit: 5, windowMs: 10000 }; // offer and answer share this bucket (D-030)
const iceLimit = { key: 'voice.ice', limit: 60, windowMs: 10000 };

/** WebRTC signaling for 1-vs-1 match voice (D-027, D-033). Audio never passes through the server. */
module.exports = {
  'voice.config': {
    requireAuth: true,
    handle: defineHandler(z.object({}), async ({ socket, id, userId }) => {
      send(socket, 'voice.config', signaling.voiceConfig(userId), id);
    }),
  },
  'voice.offer': {
    requireAuth: true,
    handle: defineHandler(
      z.object({ gameId: objectId, sdp }),
      async ({ socket, id, data, userId }) => {
        await signaling.offer(userId, data, socket);
        send(socket, 'voice.offer.ok', { gameId: data.gameId }, id);
      },
      { rateLimit: sdpLimit }
    ),
  },
  'voice.answer': {
    requireAuth: true,
    handle: defineHandler(
      z.object({ gameId: objectId, sdp }),
      async ({ socket, id, data, userId }) => {
        signaling.answer(userId, data, socket);
        send(socket, 'voice.answer.ok', { gameId: data.gameId }, id);
      },
      { rateLimit: sdpLimit }
    ),
  },
  'voice.ice': {
    requireAuth: true,
    handle: defineHandler(
      z.object({ gameId: objectId, candidate }),
      async ({ socket, id, data, userId }) => {
        signaling.iceCandidate(userId, data, socket);
        // Candidates come in bursts: only acknowledge if the client asked for a reply.
        if (id !== undefined) send(socket, 'voice.ice.ok', { gameId: data.gameId }, id);
      },
      { rateLimit: iceLimit }
    ),
  },
  'voice.end': {
    requireAuth: true,
    handle: defineHandler(gameRef, async ({ socket, id, data, userId }) => {
      signaling.hangUp(userId, data);
      send(socket, 'voice.end.ok', { gameId: data.gameId }, id);
    }),
  },
  'voice.failed': {
    requireAuth: true,
    handle: defineHandler(gameRef, async ({ socket, id, data, userId }) => {
      send(socket, 'voice.failed.ok', signaling.reportFailure(userId, data), id);
    }),
  },
};
