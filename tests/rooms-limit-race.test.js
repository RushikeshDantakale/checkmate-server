'use strict';

// The hosted-room limit must hold even when creations arrive at the same moment (D-058).
// Before the fix the limit was only a count check, so simultaneous creations could exceed it by one.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const g = require('./gameHelpers');
const r = require('./roomHelpers');
const config = require('../src/config');
const { AnalysisRoom } = require('../src/database/models');

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

async function sendAll(sockets, type, payloadFor) {
  const sent = sockets.map((socket, i) => ({ socket, id: g.raw(socket, type, payloadFor(i)) }));
  const replies = [];
  for (const { socket, id } of sent) {
    for (;;) {
      const msg = await socket.next(5000);
      if (msg.id === id) {
        replies.push(msg);
        break;
      }
    }
  }
  return replies;
}

test('simultaneous room creations never exceed the hosted-room limit', async () => {
  const max = config.rooms.maxHosted;
  const host = await r.makePlayer(server, api);
  const sockets = [host.socket];
  for (let i = 0; i < max + 2; i += 1) sockets.push(await g.authed(server.wsUrl, host.user.token));

  // Fill all but one seat one after the other, then race for the last one with many devices at once.
  for (let i = 0; i < max - 1; i += 1) await g.call(host.socket, 'room.create', { name: `base ${i}` }, 'room.create.ok');
  const racers = sockets.slice(1);
  const replies = await sendAll(racers, 'room.create', (i) => ({ name: `race ${i}` }));

  const created = replies.filter((m) => m.type === 'room.create.ok');
  const refused = replies.filter((m) => m.type === 'error' && m.payload.code === 'ROOM_LIMIT');
  assert.equal(created.length, 1, 'exactly one racer gets the last seat');
  assert.equal(refused.length, racers.length - 1, 'all the others are told ROOM_LIMIT');
  assert.equal(await AnalysisRoom.countDocuments({ hostId: host.user.id, status: 'open' }), max, 'the database holds exactly the limit');
});

test('a refused creation leaves no room behind and the limit frees up when a room closes', async () => {
  const max = config.rooms.maxHosted;
  const host = await r.makePlayer(server, api);
  const ids = [];
  for (let i = 0; i < max; i += 1) {
    const res = await g.call(host.socket, 'room.create', { name: `r${i}` }, 'room.create.ok');
    ids.push(res.room.id);
  }
  assert.equal(await g.errorOf(host.socket, 'room.create', { name: 'one too many' }), 'ROOM_LIMIT');
  assert.equal(await AnalysisRoom.countDocuments({ hostId: host.user.id }), max, 'no leftover document from the refused creation');

  await g.call(host.socket, 'room.close', { roomId: ids[0] }, 'room.close.ok');
  const again = await g.call(host.socket, 'room.create', { name: 'fits now' }, 'room.create.ok');
  assert.ok(again.room.id);
});
