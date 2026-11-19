'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installProcessGuards } = require('../src/utils/processGuards');

function setup(options = {}) {
  const proc = new EventEmitter();
  const calls = { fatal: [], error: [], exit: [] };
  const logger = {
    fatal: (...a) => calls.fatal.push(a),
    error: (...a) => calls.error.push(a),
  };
  let clock = 1000;
  const guards = installProcessGuards({
    logger,
    proc,
    exit: (code) => calls.exit.push(code),
    now: () => clock,
    options: { exitDelayMs: 5, ...options },
  });
  return { proc, calls, guards, advance: (ms) => { clock += ms; } };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('an uncaught exception is logged and the process exits with code 1', async () => {
  const { proc, calls } = setup();
  proc.emit('uncaughtException', new Error('boom'));
  assert.equal(calls.fatal.length, 1);
  assert.equal(calls.fatal[0][0].reason, 'uncaughtException');
  await wait(30);
  assert.deepEqual(calls.exit, [1]);
});

test('two uncaught exceptions in a row exit only once', async () => {
  const { proc, calls } = setup();
  proc.emit('uncaughtException', new Error('one'));
  proc.emit('uncaughtException', new Error('two'));
  await wait(30);
  assert.equal(calls.fatal.length, 1);
  assert.deepEqual(calls.exit, [1]);
});

test('a single unhandled rejection is logged but does not exit', async () => {
  const { proc, calls, guards } = setup();
  proc.emit('unhandledRejection', new Error('forgotten catch'));
  await wait(30);
  assert.equal(calls.error.length, 1);
  assert.equal(calls.exit.length, 0);
  assert.equal(guards.rejectionCount(), 1);
});

test('too many unhandled rejections inside the window exit the process', async () => {
  const { proc, calls } = setup({ maxRejections: 3 });
  for (let i = 0; i < 4; i += 1) proc.emit('unhandledRejection', new Error(`r${i}`));
  await wait(30);
  assert.equal(calls.fatal.length, 1);
  assert.equal(calls.fatal[0][0].reason, 'too many unhandled rejections');
  assert.deepEqual(calls.exit, [1]);
});

test('rejections spread over time are forgotten and never reach the limit', async () => {
  const { proc, calls, advance, guards } = setup({ maxRejections: 2, windowMs: 1000 });
  for (let i = 0; i < 6; i += 1) {
    proc.emit('unhandledRejection', new Error(`r${i}`));
    advance(1500);
  }
  await wait(30);
  assert.equal(calls.exit.length, 0);
  assert.equal(guards.rejectionCount(), 1);
});

test('non-Error rejection values are logged safely', () => {
  const { proc, calls } = setup();
  proc.emit('unhandledRejection', 'a plain string');
  assert.equal(calls.error[0][0].err.value, 'a plain string');
});

test('uninstall removes both handlers', () => {
  const { proc, guards } = setup();
  assert.equal(proc.listenerCount('uncaughtException'), 1);
  assert.equal(proc.listenerCount('unhandledRejection'), 1);
  guards.uninstall();
  assert.equal(proc.listenerCount('uncaughtException'), 0);
  assert.equal(proc.listenerCount('unhandledRejection'), 0);
});
