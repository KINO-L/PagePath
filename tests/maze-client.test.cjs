'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const calls = [], timers = new Map(); let response, nextTimer = 0;
  const P = { MapCodec: { encode() { throw new Error('cached screenshot must be reused'); } },
    MazeTransport: { async decode(packet, source, options) { return { packet, source, signal: options.signal }; } } };
  const runtime = { id: 'pagepath-test', sendMessage(message) {
    calls.push(message);
    return message.type === 'PAGEPATH_GENERATE' ? new Promise(resolve => { response = resolve; }) : Promise.resolve({ ok: true });
  } };
  const context = vm.createContext({ __PAGEPATH__: P, chrome: { runtime },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/content/mazeClient.js'), 'utf8'), context);
  const snapshot = { packet: { test: 'compressed-source' }, analysis: { test: 'source' } };
  return { P, calls, timers, snapshot, respond: value => response(value),
    run: signal => P.MazeClient.generate(snapshot, [{ x: 1, y: 2, width: 3, height: 4 }], [], { signal }) };
}

test('maze client sends the cached packet and reconstructs the result with the original source', async () => {
  const h = harness(), controller = new AbortController(), pending = h.run(controller.signal);
  await flush();
  assert.equal(h.calls[0].packet, h.snapshot.packet);
  assert.ok(Number.isInteger(h.calls[0].seed));
  h.respond({ ok: true, level: { test: 'generated' } });
  const result = await pending;
  assert.equal(result.source, h.snapshot.analysis); assert.equal(result.signal, controller.signal);
  assert.equal(h.timers.size, 0);
  controller.abort(); assert.equal(h.calls.length, 1, 'completed jobs have no abort listener');
});

test('cancellation rejects immediately and requests termination without waiting for the worker', async () => {
  const h = harness(), controller = new AbortController(), pending = h.run(controller.signal);
  await flush(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.calls[1].type, 'PAGEPATH_CANCEL_GENERATION');
  assert.equal(h.calls[1].requestId, h.calls[0].requestId);
  assert.equal(h.timers.size, 0);
  h.respond({ ok: true, level: {} }); await flush();
  assert.equal(h.calls.length, 2, 'late replies cannot create another job');
});

test('abort before dispatch creates no job; abort during decoding never returns a level', async () => {
  const early = harness(), a = new AbortController(); a.abort();
  await assert.rejects(early.run(a.signal), { name: 'AbortError' }); assert.equal(early.calls.length, 0);
  const h = harness(), b = new AbortController();
  h.P.MazeTransport.decode = async () => { b.abort(); return {}; };
  const pending = h.run(b.signal); await flush(); h.respond({ ok: true, level: {} });
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(h.timers.size, 0);
});

test('worker errors and timeouts release listeners and timeout cancels the active request', async () => {
  const h = harness(), pending = h.run(); await flush();
  h.respond({ ok: false, error: '地图暂未准备好，请刷新后重试' });
  await assert.rejects(pending, /地图暂未准备好/); assert.equal(h.timers.size, 0);
  const slow = harness(), waiting = slow.run(); await flush();
  [...slow.timers.values()][0]();
  await assert.rejects(waiting, /地图暂未准备好/);
  assert.equal(slow.calls.at(-1).type, 'PAGEPATH_CANCEL_GENERATION'); assert.equal(slow.timers.size, 0);
});
