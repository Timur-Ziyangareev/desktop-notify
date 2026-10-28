/*
 * desktop-notify — desktop (Windows toast) notifications with a sound cue for
 * three moments of a DSH turn: the request finished, the agent needs the user
 * (approval / question), and the request failed.
 *
 * The plugin rides on public client services only:
 *   - `api-session/status` / `api-session/error` Remote events (running + failures)
 *   - `uiSession.sessionStatus` (running, pendingInteraction per Session)
 *   - `sessions.list` (titles, subagent detection)
 *
 * No React, no slot: it stays headless and only touches the browser API.
 */
(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__ || typeof window.__ModuleLoader__.load !== 'function') return;

  window.__ModuleLoader__.load({
    id: '@local/desktop-notify',
    factory: function () {
      'use strict';

      /* ------------------------------------------------------------------ *
       * Settings (localStorage, read on every use so edits apply at once)
       * ------------------------------------------------------------------ */

      var KEYS = {
        enabled: 'dsh-notify.enabled',
        sound: 'dsh-notify.sound',
        volume: 'dsh-notify.volume',
        subagents: 'dsh-notify.subagents',
        inApp: 'dsh-notify.inApp',
        lang: 'dsh-notify.lang'
      };

      var DEFAULT_VOLUME = 0.3;

      function flag(key, fallback) {
        try {
          var raw = window.localStorage.getItem(key);
          if (raw === null) return fallback;
          raw = String(raw).trim().toLowerCase();
          if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
          if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
          return fallback;
        } catch (error) {
          return fallback;
        }
      }

      function volume() {
        try {
          var raw = window.localStorage.getItem(KEYS.volume);
          if (raw === null) return DEFAULT_VOLUME;
          var value = Number(raw);
          if (!isFinite(value)) return DEFAULT_VOLUME;
          return Math.min(1, Math.max(0, value));
        } catch (error) {
          return DEFAULT_VOLUME;
        }
      }

      function language() {
        try {
          var forced = window.localStorage.getItem(KEYS.lang);
          if (forced === 'ru' || forced === 'en') return forced;
        } catch (error) { /* fall through */ }
        var tag = String((navigator && navigator.language) || 'en').toLowerCase();
        return tag.indexOf('ru') === 0 ? 'ru' : 'en';
      }

      var TEXT = {
        ru: {
          done: 'Готово',
          doneBody: 'Запрос выполнен',
          approval: 'Нужны права',
          question: 'Нужен ответ',
          plan: 'Нужно подтвердить план',
          error: 'Ошибка',
          errorBody: 'Запрос завершился с ошибкой',
          tool: 'Инструмент',
          session: 'Сессия'
        },
        en: {
          done: 'Done',
          doneBody: 'The request has finished',
          approval: 'Permission needed',
          question: 'Answer needed',
          plan: 'Plan review needed',
          error: 'Error',
          errorBody: 'The request failed',
          tool: 'Tool',
          session: 'Session'
        }
      };

      function text() {
        return TEXT[language()] || TEXT.en;
      }

      function clip(value, limit) {
        var source = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
        if (source.length <= limit) return source;
        return source.slice(0, limit - 1) + '…';
      }

      /* ------------------------------------------------------------------ *
       * Sound: short WebAudio cues, one distinct pattern per kind
       * ------------------------------------------------------------------ */

      var PATTERNS = {
        // Rising two-note chime: work is over.
        done: [
          { freq: 783.99, at: 0, dur: 0.16, type: 'sine', gain: 0.9 },
          { freq: 1046.5, at: 0.13, dur: 0.24, type: 'sine', gain: 0.9 }
        ],
        // Three bright beeps: the agent is waiting for a decision.
        attention: [
          { freq: 1046.5, at: 0, dur: 0.1, type: 'triangle', gain: 0.8 },
          { freq: 1318.51, at: 0.15, dur: 0.1, type: 'triangle', gain: 0.8 },
          { freq: 1046.5, at: 0.3, dur: 0.16, type: 'triangle', gain: 0.8 }
        ],
        // Low descending pair: something went wrong.
        error: [
          { freq: 311.13, at: 0, dur: 0.22, type: 'triangle', gain: 0.9 },
          { freq: 207.65, at: 0.24, dur: 0.32, type: 'triangle', gain: 0.9 }
        ]
      };

      var audio = null;

      function audioContext() {
        try {
          if (audio === null) {
            var Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return null;
            audio = new Ctor();
          }
          if (audio.state === 'suspended' && typeof audio.resume === 'function') {
            try { audio.resume(); } catch (error) { /* stays suspended */ }
          }
          return audio;
        } catch (error) {
          return null;
        }
      }

      /** Schedule one pattern on any AudioContext-shaped object. */
      function play(context, notes, level, when) {
        if (!context) return false;
        var start = (typeof when === 'number' ? when : context.currentTime || 0) + 0.02;
        for (var index = 0; index < notes.length; index += 1) {
          var note = notes[index];
          var osc = context.createOscillator();
          var amp = context.createGain();
          if (!osc || !amp) return false;
          var from = start + note.at;
          var to = from + note.dur;
          osc.type = note.type || 'sine';
          osc.frequency.setValueAtTime(note.freq, from);
          var peak = Math.max(0.0002, level * (note.gain === undefined ? 1 : note.gain));
          amp.gain.setValueAtTime(0.0001, from);
          amp.gain.exponentialRampToValueAtTime(peak, from + 0.015);
          amp.gain.exponentialRampToValueAtTime(0.0001, to);
          osc.connect(amp);
          amp.connect(context.destination);
          osc.start(from);
          osc.stop(to + 0.03);
        }
        return true;
      }

      function sound(kind) {
        if (!flag(KEYS.sound, true)) return;
        var notes = PATTERNS[kind];
        if (!notes) return;
        play(audioContext(), notes, volume());
      }

      /* ------------------------------------------------------------------ *
       * Notification surfaces: OS toast first, in-app card as a fallback
       * ------------------------------------------------------------------ */

      var toastHostId = 'desktop-notify-host';

      function focusWindow() {
        try { window.focus(); } catch (error) { /* ignore */ }
      }

      function inApp(title, body) {
        if (!flag(KEYS.inApp, true)) return;
        try {
          var host = document.getElementById(toastHostId);
          if (!host) {
            host = document.createElement('div');
            host.id = toastHostId;
            host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none';
            document.body.appendChild(host);
          }
          while (host.children.length >= 3) host.removeChild(host.firstChild);

          var card = document.createElement('div');
          card.style.cssText = 'pointer-events:auto;max-width:360px;min-width:220px;padding:10px 14px;border-radius:12px;background:rgba(30,30,34,0.97);color:#fff;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 10px 30px rgba(0,0,0,0.38);border:1px solid rgba(255,255,255,0.12);cursor:default';
          var heading = document.createElement('div');
          heading.textContent = title;
          heading.style.cssText = 'font-weight:600;margin-bottom:2px';
          card.appendChild(heading);
          if (body) {
            var line = document.createElement('div');
            line.textContent = body;
            line.style.cssText = 'opacity:0.82;white-space:pre-wrap';
            card.appendChild(line);
          }
          card.addEventListener('click', focusWindow);
          host.appendChild(card);
          setTimeout(function () {
            card.style.transition = 'opacity 220ms ease';
            card.style.opacity = '0';
            setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 260);
          }, 9000);
        } catch (error) { /* a DOM-less host is fine: the OS toast still showed */ }
      }

      var permissionAsked = false;

      function askPermission() {
        if (permissionAsked) return;
        permissionAsked = true;
        try {
          if (typeof window.Notification !== 'function') return;
          if (window.Notification.permission !== 'default') return;
          var request = window.Notification.requestPermission();
          if (request && typeof request.then === 'function') request.then(function () {}, function () {});
        } catch (error) { /* Electron grants it silently */ }
      }

      function osToast(title, body) {
        var shown = false;
        if (typeof window.Notification !== 'function') return false;
        try {
          if (window.Notification.permission !== 'granted') {
            askPermission();
            return false;
          }
          var notification = new window.Notification(title, { body: body, silent: true });
          notification.onclick = function () {
            focusWindow();
            try { notification.close(); } catch (error) { /* ignore */ }
          };
          shown = true;
        } catch (error) {
          shown = false;
        }
        return shown;
      }

      function notify(kind, title, body, sessionId) {
        if (!flag(KEYS.enabled, true)) return;
        sound(kind);
        var shown = osToast(title, body);
        if (!shown) inApp(title, body);
        if (window.console && typeof window.console.debug === 'function') {
          window.console.debug('[desktop-notify]', kind, sessionId || '', title, body || '');
        }
      }

      /* ------------------------------------------------------------------ *
       * Session bookkeeping
       * ------------------------------------------------------------------ */

      function rowsOf(sessions) {
        try {
          var snapshot = sessions.list.getSnapshot();
          return (snapshot && snapshot.byId) || {};
        } catch (error) {
          return {};
        }
      }

      function rowOf(sessions, sessionId) {
        var rows = rowsOf(sessions);
        return rows[sessionId];
      }

      function isSubagent(row) {
        if (!row) return false;
        return row.origin === 'subagent' || row.parentSessionId !== undefined;
      }

      function titleOf(sessions, sessionId) {
        var row = rowOf(sessions, sessionId);
        var title = row && row.title;
        return typeof title === 'string' && title !== '' ? title : '';
      }

      function shouldNotify(sessions, sessionId) {
        var row = rowOf(sessions, sessionId);
        if (!row) return true;
        if (isSubagent(row)) return flag(KEYS.subagents, false);
        return true;
      }

      function interactionText(pending) {
        var words = text();
        if (pending && pending.kind === 'approval') {
          var tool = pending.toolName ? String(pending.toolName) : '';
          var reason = '';
          var display = pending.displayReason;
          if (display && typeof display === 'object') {
            reason = display[language()] || display.en || '';
          } else if (typeof display === 'string') {
            reason = display;
          }
          if (!reason && typeof pending.reason === 'string') reason = pending.reason;
          var parts = [];
          if (tool) parts.push(words.tool + ': ' + tool);
          if (reason) parts.push(clip(reason, 140));
          return { title: words.approval, body: parts.join(' — ') };
        }
        var questions = pending && pending.questions;
        if (pending && (pending.kind === 'question' || pending.kind === 'plan-review') && questions && questions.length) {
          var first = questions[0] || {};
          var label = first.header || first.question || '';
          return {
            title: pending.kind === 'plan-review' ? words.plan : words.question,
            body: clip(label, 140)
          };
        }
        return { title: words.question, body: '' };
      }

      /* ------------------------------------------------------------------ *
       * Plugin body
       * ------------------------------------------------------------------ */

      function apply(ctx) {
        var disposers = [];
        var running = new Map();
        var pendingSeen = new Map();
        var erroredAt = new Map();
        var sessions = ctx.sessions;
        var remote = ctx.remote;
        var uiSession = typeof ctx.get === 'function' ? ctx.get('uiSession') : ctx.uiSession;

        // Baseline: everything already running or already waiting is old news.
        try {
          var snapshot = sessions.list.getSnapshot();
          var rows = (snapshot && snapshot.byId) || {};
          for (var id in rows) {
            if (Object.prototype.hasOwnProperty.call(rows, id)) running.set(id, rows[id].running === true);
          }
        } catch (error) { /* an unloaded list simply has no baseline */ }

        // Finished / failed turns.
        try {
          var offStatus = remote.$on('api-session/status', function (sessionId, isRunning) {
            var before = running.get(sessionId);
            running.set(sessionId, isRunning === true);
            if (isRunning) return;
            if (before !== true) return;
            if (!shouldNotify(sessions, sessionId)) return;
            var failedAt = erroredAt.get(sessionId);
            if (failedAt !== undefined && Date.now() - failedAt < 6000) return;
            var words = text();
            var title = titleOf(sessions, sessionId);
            notify('done', words.done, title || words.doneBody, sessionId);
          });
          if (typeof offStatus === 'function') disposers.push(offStatus);
        } catch (error) { /* no Remote layer: the sessionStatus feed below still works */ }

        try {
          var offError = remote.$on('api-session/error', function (sessionId, message) {
            if (!shouldNotify(sessions, sessionId)) return;
            erroredAt.set(sessionId, Date.now());
            var words = text();
            notify('error', words.error, clip(message || words.errorBody, 160), sessionId);
          });
          if (typeof offError === 'function') disposers.push(offError);
        } catch (error) { /* ignore */ }

        // Pending interactions (approval requests, questions, plan review).
        if (uiSession && uiSession.sessionStatus && typeof uiSession.sessionStatus.subscribe === 'function') {
          try {
            var status = uiSession.sessionStatus;
            var current = status.getSnapshot();
            if (current && typeof current.forEach === 'function') {
              current.forEach(function (state, sessionId) {
                if (state && state.pendingInteraction) pendingSeen.set(sessionId, state.pendingInteraction);
              });
            }
            var offPending = status.subscribe(function () {
              var next = status.getSnapshot();
              if (!next || typeof next.forEach !== 'function') return;
              next.forEach(function (state, sessionId) {
                var pending = state && state.pendingInteraction;
                var before = pendingSeen.get(sessionId);
                if (!pending) {
                  if (before !== undefined) pendingSeen.delete(sessionId);
                  return;
                }
                if (pending === before) return;
                pendingSeen.set(sessionId, pending);
                if (!shouldNotify(sessions, sessionId)) return;
                var message = interactionText(pending);
                notify('attention', message.title, message.body, sessionId);
              });
            });
            if (typeof offPending === 'function') disposers.push(offPending);
          } catch (error) { /* ignore */ }
        }

        // Audio unlocked by the first gesture in a browser tab; Electron needs none.
        var unlock = function () { audioContext(); askPermission(); };
        try {
          window.addEventListener('pointerdown', unlock, true);
          window.addEventListener('keydown', unlock, true);
          disposers.push(function () {
            window.removeEventListener('pointerdown', unlock, true);
            window.removeEventListener('keydown', unlock, true);
          });
        } catch (error) { /* ignore */ }

        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            return function () {
              for (var index = 0; index < disposers.length; index += 1) {
                try { disposers[index](); } catch (error) { /* ignore */ }
              }
              disposers.length = 0;
            };
          }, 'desktop-notify: subscriptions');
        }

        return disposers;
      }

      return {
        name: 'desktop-notify',
        inject: ['sessions', 'remote', 'uiSession'],
        apply: apply,
        // Exposed for the offline test harness; the host ignores unknown keys.
        _test: {
          patterns: PATTERNS,
          play: play,
          volume: volume,
          language: language,
          text: text,
          clip: clip,
          interactionText: interactionText,
          keys: KEYS
        }
      };
    }
  });
})();
