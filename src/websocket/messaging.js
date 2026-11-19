'use strict';

/** Send helpers shared by the WebSocket server and its handlers. */
function send(socket, type, payload, id) {
  if (socket.readyState !== socket.OPEN) return;
  const message = { type, payload };
  if (id !== undefined) message.id = id;
  socket.send(JSON.stringify(message));
}

function sendError(socket, code, message, id) {
  send(socket, 'error', { code, message }, id);
}

module.exports = { send, sendError };
