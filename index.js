/*
 * Host half of `desktop-notify`.
 *
 * The browser half does the announcements; this half carries them to a phone
 * through an ntfy server, because that request must not depend on CORS and the
 * topic belongs in a file rather than in the page. The row also exists so the
 * client module table serves `client.js` to the page.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { publish } from './lib/push.js';

export const name = 'desktop-notify';
export const inject = ['webServer'];

/** `~/.dsh/desktop-notify.json`, or the DSH home of this process. */
function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'desktop-notify.json');
}

function readConfig() {
  try {
    if (!existsSync(configPath())) return null;
    // Editors on Windows like to keep a BOM; JSON.parse does not.
    const text = readFileSync(configPath(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/desktop-notify/push',
    handler: async (req, res) => {
      let params;
      try {
        params = new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams;
      } catch (error) {
        send(res, 400, { ok: false, reason: 'bad-query' });
        return;
      }

      const config = readConfig();
      const ntfy = config && config.ntfy;
      if (!ntfy || typeof ntfy.topic !== 'string' || ntfy.topic === '') {
        send(res, 409, { ok: false, reason: 'not-configured' });
        return;
      }
      if (config.phone === false) {
        send(res, 409, { ok: false, reason: 'phone-disabled' });
        return;
      }

      try {
        const result = await publish({
          server: ntfy.server || 'https://ntfy.sh',
          topic: ntfy.topic,
          title: params.get('title') || 'DeepSeek Harness',
          message: params.get('body') || '',
          silent: params.get('silent') === '1',
        });
        send(res, result.ok ? 200 : 502, result);
      } catch (error) {
        send(res, 502, { ok: false, reason: String((error && error.message) || error) });
      }
    },
  }), 'desktop-notify: phone push');
}
