'use strict';

const { send } = require('../messaging');
const authHandler = require('./auth.handler');

/**
 * Event table. requireAuth=true events are rejected with UNAUTHENTICATED / TOKEN_EXPIRED
 * until the socket has a valid `auth`. Later phases register game, chat, room and
 * signaling events here.
 */
module.exports = {
  ping: {
    requireAuth: false,
    handle: ({ socket, id }) => send(socket, 'pong', { serverTime: Date.now() }, id),
  },
  auth: { requireAuth: false, handle: authHandler.handle },
  whoami: {
    requireAuth: true,
    handle: ({ socket, id }) =>
      send(socket, 'whoami', { userId: socket.auth.userId, sessionId: socket.auth.sessionId }, id),
  },
  ...require('./game.handler'),
  ...require('./matchmaking.handler'),
  ...require('./chat.handler'),
  ...require('./voice.handler'),
  ...require('./spectate.handler'),
  ...require('./room.handler'),
};
