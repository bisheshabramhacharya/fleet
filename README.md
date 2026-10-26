# fleet

One dashboard for every AI token and dollar across all your machines.

fleet runs quietly on each of your computers (Windows, macOS, Linux). It reads the logs your AI tools already save and sends only the numbers to one hub on your private Tailscale network. The hub prices everything, adds your subscriptions, provider billing and live plan limits, and shows it all in a dashboard modelled on T3 Code's usage page.

No chat text ever leaves a device. There is no telemetry.

## What it reads

| Tool | Where | Timing |
|---|---|---|
| Claude Code | `~/.claude/projects` | per call |
| Codex | `~/.codex` and every `~/.codex-*` home (live and archived sessions) | per call |
| Droid (Factory) | `~/.factory/sessions/*.settings.json`, including Factory credits | per session |
| Command Code | `~/.commandcode/projects` | per call, with Command Code's own cost |
| Pi, oh-my-pi | `~/.pi/agent/sessions`, `~/.omp/agent/sessions` | per call |
| OpenCode | `~/.local/share/opencode` (SQLite and legacy JSON) | per call |
| DeepSeek Harness | `~/.dsh/sessions` (zstd-compressed) | per call |
| Hermes | every profile's `state.db` (`~/.hermes`, `%LOCALAPPDATA%\hermes`) | per session and model |
| Grok CLI | `~/.grok/sessions/**/updates.jsonl` | per call |
| Your own scripts | the fleet inbox folder (see below) | per call |

Per-session tools only save one running total per session, so their usage lands on the session's last active day. The dashboard marks them.

Plan limits: Codex (read from its logs) and Claude (read with Claude Code's saved login, read-only).

Billing: DeepSeek balance, OpenRouter credits, OpenAI and Anthropic daily costs (admin keys). Keys are encrypted with the system keychain and stay on the hub.

## Install

1. Download the installer for each machine from [Releases](../../releases), or build it (below).
2. Open fleet on the machine that should be the **hub** (it is the hub by default).
3. On every other machine, open fleet, go to **Devices**, enter the hub's Tailscale address and the pair code shown on the hub.

First releases are unsigned. Windows SmartScreen shows "More info → Run anyway". On macOS, right-click the app and choose **Open** the first time.

Headless Linux boxes can run the command-line version (Node.js 22.13 or newer):

```sh
node dist/cli.cjs pair <hub-address>:8742 <PAIRCODE>
node dist/cli.cjs run
```

## Report AI calls from your own scripts

Append one JSON line per call to any `.jsonl` file in the inbox folder (shown in Settings):

```json
{"time":"2026-10-26T18:00:00Z","app":"listing-hub","model":"gpt-6.1-sol","input":1200,"output":300,"costUsd":0.004}
```

Fields: `time` and `model` are required. Optional: `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `costUsd`, `app`, `session`, `id`.

## Build

```sh
npm install
npm test
npm run build
npx electron-builder --win   # or --mac, --linux
```

`npm start` builds and opens the app. `node dist/cli.cjs scan` prints this machine's last 7 days without the app.

## How it works

- Each install scans tool logs every 2 minutes. Only changed files are read again; line logs resume where they stopped.
- Records hold time, tool, model, session, project folder name and token counts. Never prompts or replies.
- A collector pushes changed files to the hub over Tailscale with a device token. Pushes are safe to repeat, and a device that was offline catches up without double counting.
- The hub prices records when you look at them, using the LiteLLM price table (refreshed daily) plus any prices you set, so price fixes apply to history.
- The hub listens only on localhost and its Tailscale address (port 8742).

## Credits

The usage engine (pricing, aggregation, the Claude, Codex, Pi, OpenCode and Grok readers) and the dashboard design are adapted from [T3 Code](https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc., used under the MIT license. See [NOTICE](NOTICE).

## License

[MIT](LICENSE)
