/*
 * Unit tests for the Host-side ntfy publisher.
 *
 *   node test/push.test.mjs
 *
 * Set NTFY_LIVE=1 to also publish one real message to ntfy.sh and require 200.
 */

import assert from 'node:assert/strict';

import { normalizeServer, publish } from '../lib/push.js';

const calls = [];

function fakeFetch(response = { ok: true, status: 200, text: async () => '{"id":"x"}' }) {
  return async (url, options) => {
    calls.push({ url, options });
    return response;
  };
}

/* 1. a loud message is priority 4 and rings */
await publish({
  server: 'https://ntfy.sh',
  topic: 'dsh-test',
  title: 'Готово',
  message: 'Правка макета',
}, fakeFetch());

assert.equal(calls.length, 1);
assert.equal(calls[0].url, 'https://ntfy.sh');
assert.equal(calls[0].options.method, 'POST');
const loud = JSON.parse(calls[0].options.body);
assert.equal(loud.topic, 'dsh-test');
assert.equal(loud.title, 'Готово');
assert.equal(loud.message, 'Правка макета');
assert.equal(loud.priority, 4);
assert.deepEqual(loud.tags, ['bell']);
console.log('PASS loud message carries title, text and priority 4');

/* 2. a muted message is quiet */
calls.length = 0;
await publish({
  server: 'https://ntfy.sh',
  topic: 'dsh-test',
  title: 'Готово',
  message: 'Правка макета',
  silent: true,
}, fakeFetch());
const quiet = JSON.parse(calls[0].options.body);
assert.equal(quiet.priority, 1, 'quiet pushes use the minimum priority');
assert.deepEqual(quiet.tags, ['no_bell']);
console.log('PASS muted message drops to priority 1 without a sound tag');

/* 3. the server is normalised to its origin and must be https */
assert.equal(normalizeServer('https://ntfy.sh/some/path'), 'https://ntfy.sh');
assert.throws(() => normalizeServer('http://ntfy.sh'), /https/);
assert.throws(() => normalizeServer('http://127.0.0.1:8080'), /https/);
console.log('PASS server normalisation rejects plain http');

/* 4. a broken topic never leaves the machine */
calls.length = 0;
await assert.rejects(publish({ server: 'https://ntfy.sh', topic: 'bad topic!', title: 'x' }, fakeFetch()), /invalid ntfy topic/);
assert.equal(calls.length, 0);
console.log('PASS an invalid topic fails before any request');

/* 5. a server rejection is reported, not thrown */
const rejected = await publish({
  server: 'https://ntfy.sh',
  topic: 'dsh-test',
  title: 'x',
}, fakeFetch({ ok: false, status: 413, text: async () => 'too big' }));
assert.equal(rejected.ok, false);
assert.equal(rejected.status, 413);
console.log('PASS a rejected publish reports status instead of throwing');

/* 6. optional live smoke test against the real service */
if (process.env.NTFY_LIVE === '1') {
  const topic = 'dsh-notify-live-' + Date.now().toString(36);
  const result = await publish({
    server: 'https://ntfy.sh',
    topic,
    title: 'desktop-notify smoke test',
    message: 'If you can read this, the topic works.',
  });
  assert.equal(result.ok, true, 'ntfy should accept the message: ' + JSON.stringify(result));
  console.log('PASS live publish accepted on topic ' + topic);
}

console.log('\nall push tests passed');
