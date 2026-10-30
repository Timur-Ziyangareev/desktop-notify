# desktop-notify (DeepSeek Harness plugin)

A headless DeepSeek Harness client plugin: desktop notifications with a sound cue
for turns that finish, need the user, or fail.

**English** | [Русский](#русский)

## What it does

Three moments of a turn announce themselves on the computer, each with its own
sound pattern:

| Moment | Toast | Sound |
|---|---|---|
| The request finished | “DEEPSEEK FINISHED THE REQUEST” + the session title | rising two-note chime |
| The agent needs the user: a permission request, a question, a plan review | “Permission needed” / “Answer needed” / “Plan review needed” + the tool or question | three bright beeps |
| The request failed | “Error” + the failure text | low descending pair |

The toast is a real Windows notification, so it shows up above other windows and
stays in the Action Center. Clicking it brings the window forward. The sound is
synthesized in the page with WebAudio: no audio files, and the cue is audible
even when Windows notification sounds are turned off.

The composer row carries one control for it: a speaker between the attach button
and the permission chip (`Full access` and friends sit to its right). A click
mutes the cue — the waves beside the speaker disappear and the speaker is struck
through — and a second click brings both back. Toasts keep coming while muted.

The agent never learns about this: nothing is registered model-facing, and the
plugin adds no tokens to a request.

## Install

The package lives in the profile that runs the Desktop application. From the
repository root:

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\desktop-notify"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item .\package.json, .\index.js, .\client.js, .\cordis.patch.yml, .\README.md $dst -Force
New-Item -ItemType Directory -Force "$dst\lib" | Out-Null
Copy-Item .\lib\push.js "$dst\lib" -Force
```

Then add the dependency and the bundle to `~/.dsh/profiles/desktop/package.json`:

```json
"dependencies": { "@local/desktop-notify": "1.0.0" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/desktop-notify"] } }
```

Restart DeepSeek Harness afterwards. A client plugin reaches the page with the
index injection table built at Host startup, so a page refresh alone does not
pick it up unless HMR recomposed the profile.

## Settings

No dialog: the options are `localStorage` keys of the page, read every time a
notification is due.

| Key | Default | Meaning |
|---|---|---|
| `dsh-notify.enabled` | `1` | Master switch for toasts and sound |
| `dsh-notify.sound` | `1` | The WebAudio cue; the composer speaker writes this key |
| `dsh-notify.volume` | `2` | Requested level, `0`…`2`; above `1` the cue is soft-limited instead of digitally clipped |
| `dsh-notify.subagents` | `0` | Also announce subagent sessions |
| `dsh-notify.inApp` | `1` | In-page card when the OS toast is unavailable |
| `dsh-notify.phone` | `1` | Send the same announcement to the phone |
| `dsh-notify.lang` | browser | `ru` or `en` for the copy |

Toggle from the DevTools console of the window:

```js
localStorage.setItem('dsh-notify.sound', '0'); // silence, keep the toasts
```

## How it hooks in

The notifications are headless: the plugin subscribes to three public client
feeds and adds only the compositor speaker as UI:

- `api-session/status` — `running` true → false is a finished turn;
- `api-session/error` — the live failure outlet for a session;
- `uiSession.sessionStatus` — `pendingInteraction` carries the approval request,
  the question card, or the plan review that is waiting for an answer.

`api-session/status` also fires for subagent sessions; those are skipped unless
`dsh-notify.subagents` is on. A turn that failed suppresses the finish toast for
six seconds, so a failure is announced once, not twice.

## Phone notifications

The same announcement goes to a phone over [ntfy](https://ntfy.sh): install the
app, subscribe to one topic, and write the topic into a Host-side config. The
Host sends the request, so no CORS and no third-party script in the page.

```json
// ~/.dsh/desktop-notify.json
{
  "ntfy": { "server": "https://ntfy.sh", "topic": "dsh-your-random-topic" },
  "phone": true
}
```

- Topic names are the only secret: pick something long and random, because
  anyone who knows the topic can read it on the public server.
- The phone copy stays quiet while the speaker is muted: it is published with
  ntfy's minimum priority, so the message arrives without a sound.
- `dsh-notify.phone` = `0` stops the phone copy while the desktop keeps working.
- `phone: false` in the config does the same on the Host side.
- The ntfy app can mute the topic itself, exactly like the phone side of any
  messenger; the desktop toggle is a second switch, not a replacement.

## Token balance

The balance widget already owns the API key and the CBR rates, so it publishes
`llm-balance.snapshot` (`{ currency, amount, rub, at }`) after every successful
refresh. This plugin only reads that snapshot — it never calls the provider —
and announces one message when the rouble balance drops below the threshold:

```
ТОКЕНЫ ЗАКАНЧИВАЮТСЯ!!!
Баланс 42,50 ₽ — ниже 50,00 ₽
```

- The threshold lives in the Host config, so it is tuned in one file instead of
  the DevTools console: `"balance": { "thresholdRub": 50 }` in
  `~/.dsh/desktop-notify.json`. The page receives it from
  `GET /desktop-notify/config`.
- One message per drop, not per minute: the alert latches until the balance is
  back above the threshold, and repeats at most once per 24 hours while it stays
  below.
- A snapshot older than 15 minutes is ignored: the widget stopped refreshing, so
  the number is stale.
- `dsh-notify.balanceThreshold` in localStorage overrides the Host value for a
  quick experiment.

## Tests

`test/harness.html` runs the plugin against stubbed services in a browser:
finished, approval, question, error, subagent filtering, deduplication, the
fallback card, and an `OfflineAudioContext` render of every pattern (a silent
pattern fails the test). Run it with:

```powershell
npm install undici        # CDP client; or point UNDICI_PATH at an existing copy
node test/run.mjs
```

`EDGE_PATH` overrides the Edge executable, `CDP_PORT` and `PORT` the ports.

## Known limits

- Notifications belong to the page: with the window closed there is nothing to
  announce.
- A browser tab that never received a click cannot start audio; Electron does
  not have that restriction.
- Windows may suppress toasts in Focus Assist; that switch belongs to the OS.

## Русский

Плагин присылает уведомления на компьютер со звуком в трёх случаях:

| Когда | Уведомление | Звук |
|---|---|---|
| Запрос выполнен | «DEEPSEEK ЗАВЕРШИЛ ЗАПРОС» + название сессии | восходящий двухнотный сигнал |
| Нужны права / ответ / подтверждение плана | «Нужны права», «Нужен ответ», «Нужно подтвердить план» + инструмент или вопрос | три высоких сигнала |
| Ошибка при запросе | «Ошибка» + текст ошибки | низкий нисходящий сигнал |

Уведомление — настоящее системное (всплывает поверх окон, остаётся в центре
уведомлений Windows), по клику окно выходит вперёд. Звук синтезируется прямо в
странице, поэтому не зависит от настроек звуков уведомлений Windows.

В строке композера есть кнопка с динамиком: она стоит между кнопкой
вложений («+») и переключателем прав доступа (`Full access` и остальные
сдвинуты правее). Первый клик выключает звук — волны справа от динамика
исчезают, а сам динамик зачёркивается; второй клик возвращает всё обратно.
Уведомления при выключенном звуке продолжают приходить.

### Уведомления на телефон

Те же три события уходят на телефон через [ntfy](https://ntfy.sh): поставить
приложение, подписаться на один топик, а топик вписать в конфиг на стороне Host
(запрос отправляет Host, поэтому ни CORS, ни чужой скрипт на странице не нужны):

```json
// ~/.dsh/desktop-notify.json
{
  "ntfy": { "server": "https://ntfy.sh", "topic": "dsh-ваш-случайный-топик" },
  "phone": true
}
```

- Имя топика — единственный секрет: на публичном сервере его может прочитать
  любой, кто его знает, поэтому имя должно быть длинным и случайным.
- Пока динамик выключен, на телефон приходит тихое уведомление (ntfy получает
  минимальный приоритет): сообщение есть, звука нет.
- `dsh-notify.phone` = `0` отключает отправку на телефон, оставляя компьютер.
- `phone: false` в конфиге делает то же самое на стороне Host.
- В самом приложении ntfy топик тоже можно замьютить — это независимый
  выключатель, кнопка на компьютере его не заменяет.

### Баланс токенов

Виджет баланса уже держит API-ключ и курсы ЦБ, поэтому он публикует
`llm-balance.snapshot` (`{ currency, amount, rub, at }`) после каждого успешного
обновления. Этот плагин только читает снапшот — к провайдеру он не ходит — и
один раз сообщает, когда баланс в рублях падает ниже порога:

```
ТОКЕНЫ ЗАКАНЧИВАЮТСЯ!!!
Баланс 42,50 ₽ — ниже 50,00 ₽
```

- Порог задаётся в конфиге Host (один файл, без DevTools):
  `"balance": { "thresholdRub": 50 }` в `~/.dsh/desktop-notify.json`;
  страница получает его из `GET /desktop-notify/config`.
- Одно сообщение на падение, а не каждую минуту: флаг держится, пока баланс не
  вернётся выше порога; если он остаётся ниже — повтор не чаще раза в сутки.
- Снапшот старше 15 минут игнорируется: значит виджет перестал обновляться.
- `dsh-notify.balanceThreshold` в `localStorage` перекрывает значение из конфига.

### Установка

Скопировать файлы в профиль `~/.dsh/profiles/desktop/node_modules/@local/desktop-notify`,
добавить `@local/desktop-notify` в `dependencies` и в `dsh.profile.bundles`
файла `~/.dsh/profiles/desktop/package.json`, затем перезапустить DeepSeek
Harness.

### Настройки

Без окна настроек — ключи `localStorage` страницы читаются при каждом
уведомлении: `dsh-notify.enabled` (вкл/выкл), `dsh-notify.sound` (звук),
`dsh-notify.volume` (громкость 0…2, по умолчанию 2 — выше 1 сигнал проходит
через мягкий лимитер), `dsh-notify.subagents`
(уведомлять о субагентах), `dsh-notify.inApp` (всплывающая карточка внутри
окна), `dsh-notify.lang` (`ru`/`en`).

Отключить только звук:

```js
localStorage.setItem('dsh-notify.sound', '0');
```
