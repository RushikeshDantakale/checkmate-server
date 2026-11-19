'use strict';

/**
 * In-memory registry of AUTHENTICATED sockets, keyed by user.
 * One account may have several sockets (several devices). RAM only: it is
 * rebuilt as clients reconnect after a restart. Never the source of truth for games.
 */
const byUser = new Map(); // userId -> Set<socket>

/** Adds the socket. Returns true if this is the user's first live socket (user just came online). */
function add(socket) {
  const userId = socket.auth.userId;
  let set = byUser.get(userId);
  if (!set) {
    set = new Set();
    byUser.set(userId, set);
  }
  const first = set.size === 0;
  set.add(socket);
  socket.registered = true;
  return first;
}

/** Removes the socket. Returns true if it was the user's last socket (user just went offline). */
function remove(socket) {
  if (!socket.registered || !socket.auth) return false;
  socket.registered = false;
  const set = byUser.get(socket.auth.userId);
  if (!set) return false;
  set.delete(socket);
  if (set.size === 0) {
    byUser.delete(socket.auth.userId);
    return true;
  }
  return false;
}

function isOnline(userId) {
  return byUser.has(String(userId));
}

function socketsOf(userId) {
  return Array.from(byUser.get(String(userId)) || []);
}

/**
 * Sends an event to every connected device of a user (optionally skipping one socket,
 * e.g. the one that already got a direct reply). Returns how many sockets received it.
 */
function sendToUser(userId, type, payload, exceptSocket) {
  let sent = 0;
  for (const socket of socketsOf(userId)) {
    if (socket !== exceptSocket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type, payload }));
      sent += 1;
    }
  }
  return sent;
}

function closeWhere(predicate, code, reason) {
  for (const set of byUser.values()) {
    for (const socket of Array.from(set)) {
      if (predicate(socket)) socket.close(code, reason);
    }
  }
}

function closeSession(sessionId, code, reason) {
  closeWhere((s) => s.auth.sessionId === String(sessionId), code, reason);
}

function closeUser(userId, code, reason) {
  closeWhere((s) => s.auth.userId === String(userId), code, reason);
}

function onlineUserCount() {
  return byUser.size;
}

module.exports = { add, remove, isOnline, socketsOf, sendToUser, closeSession, closeUser, onlineUserCount };
