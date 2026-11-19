'use strict';

/**
 * Who is currently "in" which analysis room (D-039). RAM only, per connection.
 * A socket joins a room by sending `room.join`; the room itself (members, roles, analysis) lives in
 * MongoDB. After a restart this map is empty and clients join again.
 */
const rooms = new Map(); // roomId -> Map<connectionId, socket>
const byConnection = new Map(); // connectionId -> Set<roomId>

/** Adds the socket to the room. Returns true if this is the user's first joined device in the room. */
function subscribe(roomId, socket) {
  const userId = socket.auth.userId;
  let members = rooms.get(roomId);
  if (!members) {
    members = new Map();
    rooms.set(roomId, members);
  }
  const firstForUser = !Array.from(members.values()).some((s) => s.auth.userId === userId && s !== socket);
  members.set(socket.connectionId, socket);
  let set = byConnection.get(socket.connectionId);
  if (!set) {
    set = new Set();
    byConnection.set(socket.connectionId, set);
  }
  set.add(roomId);
  return firstForUser;
}

function isJoined(roomId, socket) {
  const members = rooms.get(roomId);
  return Boolean(members && members.get(socket.connectionId) === socket);
}

function forget(connectionId, roomId) {
  const set = byConnection.get(connectionId);
  if (!set) return;
  set.delete(roomId);
  if (set.size === 0) byConnection.delete(connectionId);
}

/** Removes every device of the user from the room (left, kicked). */
function unsubscribeUser(roomId, userId) {
  const members = rooms.get(roomId);
  if (!members) return;
  for (const [connectionId, socket] of Array.from(members)) {
    if (socket.auth.userId === String(userId)) {
      members.delete(connectionId);
      forget(connectionId, roomId);
    }
  }
  if (members.size === 0) rooms.delete(roomId);
}

/** Removes everyone from the room (closed). */
function clearRoom(roomId) {
  const members = rooms.get(roomId);
  if (!members) return;
  for (const connectionId of members.keys()) forget(connectionId, roomId);
  rooms.delete(roomId);
}

/**
 * A socket closed. Returns [{ roomId, userId, userGone }] for every room it was in; `userGone` is true
 * when the user has no other joined device left in that room (so others should see them go offline).
 */
function unsubscribeSocket({ userId, connectionId }) {
  const joined = byConnection.get(connectionId);
  if (!joined) return [];
  const result = [];
  for (const roomId of Array.from(joined)) {
    const members = rooms.get(roomId);
    if (!members) continue;
    members.delete(connectionId);
    const userGone = !Array.from(members.values()).some((s) => s.auth.userId === userId);
    if (members.size === 0) rooms.delete(roomId);
    result.push({ roomId, userId, userGone });
  }
  byConnection.delete(connectionId);
  return result;
}

function joinedSockets(roomId) {
  return Array.from((rooms.get(roomId) || new Map()).values());
}

function presentUserIds(roomId) {
  return Array.from(new Set(joinedSockets(roomId).map((s) => s.auth.userId)));
}

function isAnyoneJoined(roomId) {
  return rooms.has(roomId);
}

/** Sends to every joined socket of the room, optionally skipping one socket and some users. Returns the number of users reached. */
function broadcast(roomId, type, payload, { exceptSocket = null, skipUsers = null } = {}) {
  const text = JSON.stringify({ type, payload });
  const reached = new Set();
  for (const socket of joinedSockets(roomId)) {
    if (socket === exceptSocket || socket.readyState !== socket.OPEN) continue;
    if (skipUsers && skipUsers.has(socket.auth.userId)) continue;
    socket.send(text);
    reached.add(socket.auth.userId);
  }
  return reached.size;
}

function reset() {
  rooms.clear();
  byConnection.clear();
}

module.exports = {
  subscribe,
  isJoined,
  unsubscribeUser,
  unsubscribeSocket,
  clearRoom,
  joinedSockets,
  presentUserIds,
  isAnyoneJoined,
  broadcast,
  reset,
};
