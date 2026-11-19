'use strict';

// Shared test helpers. Test files must set process.env.NODE_ENV and any WS_* overrides
// BEFORE requiring this file (config is read once per process).
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI_TEST || 'mongodb://localhost:27017/checkmate_test';

const mongoose = require('mongoose');
const WebSocket = require('ws');
const db = require('../src/database/connection');
const { createServer } = require('../src/server');

async function startTestServer() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await mongoose.connection.dropDatabase();
  await db.ensureIndexes();
  const { httpServer, wss } = createServer();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async stop() {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      await new Promise((resolve) => httpServer.close(resolve));
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    },
  };
}

function makeApi(base) {
  async function request(method, path, { body, token } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return {
    get: (path, token) => request('GET', path, { token }),
    post: (path, body, token) => request('POST', path, { body, token }),
    patch: (path, body, token) => request('PATCH', path, { body, token }),
    del: (path, token) => request('DELETE', path, { token }),
  };
}

/** Registers a user and returns the register response plus convenience fields. */
async function registerUser(api, name) {
  const res = await api.post('/api/v1/auth/register', {
    email: `${name}@example.com`,
    username: name,
    password: `${name}-password-1`,
  });
  if (res.status !== 201) throw new Error(`register ${name} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body, id: res.body.user.id, token: res.body.accessToken, name };
}

/** Opens a socket that queues messages so tests can await them in order. */
function openSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const queue = [];
    const waiters = [];
    let closeInfo = null;
    const closeWaiters = [];

    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(msg);
      else queue.push(msg);
    });
    socket.on('close', (code) => {
      closeInfo = { code };
      for (const w of closeWaiters.splice(0)) w(closeInfo);
      for (const w of waiters.splice(0)) w.reject(new Error(`socket closed (${code}) while waiting for a message`));
    });
    socket.next = (timeoutMs = 2000) =>
      new Promise((res, rej) => {
        if (queue.length) return res(queue.shift());
        const waiter = { resolve: res, reject: rej };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) {
            waiters.splice(i, 1);
            rej(new Error('timed out waiting for a message'));
          }
        }, timeoutMs).unref();
        return undefined;
      });
    /** Puts messages back at the front of the queue (used by request/reply helpers). */
    socket.requeue = (msgs) => queue.unshift(...msgs);
    /** Waits for the next message of a given type, discarding others. */
    socket.nextOfType = async (type, timeoutMs = 2000) => {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const msg = await socket.next(Math.max(50, end - Date.now()));
        if (msg.type === type) return msg;
      }
    };
    /** Resolves with true if NO message arrives within ms. */
    socket.quietFor = async (ms) => {
      if (queue.length) return false;
      try {
        await socket.next(ms);
        return false;
      } catch {
        return true;
      }
    };
    socket.waitClose = (timeoutMs = 3000) =>
      new Promise((res, rej) => {
        if (closeInfo) return res(closeInfo);
        closeWaiters.push(res);
        setTimeout(() => rej(new Error('timed out waiting for close')), timeoutMs).unref();
        return undefined;
      });
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

/** Opens a socket, consumes server.hello, sends auth and waits for auth.ok. */
async function authedSocket(wsUrl, accessToken) {
  const socket = await openSocket(wsUrl);
  await socket.next(); // server.hello
  socket.send(JSON.stringify({ id: 'a', type: 'auth', payload: { accessToken } }));
  const ok = await socket.next();
  if (ok.type !== 'auth.ok') throw new Error(`auth failed: ${JSON.stringify(ok)}`);
  return socket;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { startTestServer, makeApi, registerUser, openSocket, authedSocket, sleep };
