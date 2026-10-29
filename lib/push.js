/*
 * Publishing one notification to an ntfy server.
 *
 * The Host half owns this: the page must not need CORS from a third-party
 * server, and the topic may live in a file instead of localStorage.
 */

const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @param server - configured server origin. */
export function normalizeServer(server) {
  const url = new URL(String(server || 'https://ntfy.sh'));
  if (url.protocol !== 'https:') throw new Error('the ntfy server must use https');
  return url.origin;
}

/**
 * Publish one message.
 * @param config - server, topic, title, message, and whether the phone must stay quiet.
 * @param fetchImpl - injectable fetch for tests.
 * @returns the server's verdict.
 */
export async function publish(config, fetchImpl = fetch) {
  const origin = normalizeServer(config.server);
  const topic = String(config.topic || '');
  if (!TOPIC_PATTERN.test(topic)) throw new Error('invalid ntfy topic');

  // Priority 1 is ntfy's "quiet" tier: the phone shows the message without a sound,
  // which is what a muted speaker must mean for the phone too.
  const payload = {
    topic,
    title: String(config.title || 'DeepSeek Harness').slice(0, 120),
    message: String(config.message || '').slice(0, 800),
    priority: config.silent ? 1 : 4,
    tags: [config.silent ? 'no_bell' : 'bell'],
  };

  const response = await fetchImpl(origin, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.timeoutMs ?? 8000),
  });

  const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
  return { ok: response.ok, status: response.status, response: String(text).slice(0, 200) };
}
