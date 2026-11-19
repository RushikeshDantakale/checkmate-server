'use strict';

process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../src/server');

let httpServer;
let wss;
let base;
let wsUrl;

before(async () => {
  ({ httpServer, wss } = createServer());
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(async () => {
  for (const socket of wss.clients) socket.terminate();
  wss.close();
  await new Promise((resolve) => httpServer.close(resolve));
});

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const queue = [];
    const waiters = [];
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    socket.next = () =>
      new Promise((res) => {
        const msg = queue.shift();
        if (msg) res(msg);
        else waiters.push(res);
      });
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

test('GET /health/live returns ok without a database', async () => {
  const res = await fetch(`${base}/health/live`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('GET /health/ready returns 503 when the database is not connected', async () => {
  const res = await fetch(`${base}/health/ready`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.db, 'down');
});

test('unknown routes return a JSON 404 error', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('security headers are set and x-powered-by is hidden', async () => {
  const res = await fetch(`${base}/health/live`);
  assert.ok(res.headers.get('x-content-type-options'));
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('websocket sends server.hello and answers app-level ping', async () => {
  const socket = await openSocket();
  const hello = await socket.next();
  assert.equal(hello.type, 'server.hello');
  assert.equal(hello.payload.protocol, 1);

  socket.send(JSON.stringify({ id: 'abc', type: 'ping' }));
  const pong = await socket.next();
  assert.equal(pong.type, 'pong');
  assert.equal(pong.id, 'abc');
  socket.close();
});

test('websocket rejects invalid JSON and unknown events without closing', async () => {
  const socket = await openSocket();
  await socket.next(); // hello

  socket.send('this is not json');
  const invalid = await socket.next();
  assert.equal(invalid.type, 'error');
  assert.equal(invalid.payload.code, 'INVALID_JSON');

  socket.send(JSON.stringify({ id: 'x1', type: 'does.not.exist' }));
  const unknown = await socket.next();
  assert.equal(unknown.payload.code, 'UNKNOWN_EVENT');
  assert.equal(unknown.id, 'x1');
  socket.close();
});

test('websocket closes connections that send oversized messages (1009)', async () => {
  const socket = await openSocket();
  await socket.next(); // hello
  const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)));
  socket.send('x'.repeat(20000));
  assert.equal(await closed, 1009);
});
