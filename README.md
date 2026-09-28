# OBS Replay Buffer Pro for Stream Deck

[![CI](https://github.com/jerptrs/streamdeck-replay-buffer-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/jerptrs/streamdeck-replay-buffer-pro/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Stream Deck plugin for the [Replay Buffer Pro](https://github.com/JoshuaPotter/replay-buffer-pro) OBS plugin.

| Action | What it does |
| --- | --- |
| **Replay Buffer On/Off** | One key that starts or stops the OBS replay buffer and shows whether it's running. |
| **Save Last 15 sec** | Saves the last 15 seconds of the replay buffer. |
| **Save Last 30 sec** | Saves the last 30 seconds. |
| **Save Last 60 sec** | Saves the last 60 seconds. |

![Key faces](docs/key-preview.png)

Top row: the toggle when on, off, starting, stopping, not connected to OBS, and with the replay buffer disabled in OBS.
Other rows: each save key when ready, when the replay buffer is off, when not connected, while saving, and once saved.

## Requirements

- Stream Deck app 7.1 or newer (Windows 10+ or macOS 12+)
- OBS Studio 28 or newer (its WebSocket server is built in)
- The [Replay Buffer Pro](https://github.com/JoshuaPotter/replay-buffer-pro) OBS plugin, with the replay buffer
  enabled in OBS (Settings → Output → Replay Buffer)

## Install

1. Download `com.replay-buffer-pro.obs.streamDeckPlugin` from the
   [latest release](https://github.com/jerptrs/streamdeck-replay-buffer-pro/releases/latest) and double-click it.
2. In OBS open **Tools → WebSocket Server Settings**, tick **Enable WebSocket server**, then click
   **Show Connect Info**.
3. Drag any of the actions onto your Stream Deck. In its settings panel, enter the host (`127.0.0.1` if OBS
   runs on the same PC), port (default `4455`) and password. These are shared by all keys of this plugin.

## How it works

The plugin talks to OBS over its built-in WebSocket server and runs Replay Buffer Pro's save actions
directly (obs-websocket's `TriggerHotkeyByName`). You don't have to bind any keys in OBS.

Replay Buffer Pro registers one action per save button: `ReplayBufferPro.SaveButton1` … `SaveButton6`
(15 s, 30 s, 60 s, 5 min, 15 min and 30 min by default). You can change those durations in OBS with
"Customize", so each Stream Deck key finds the right button by itself:

- **Auto** (default): matches the key's length against your Replay Buffer Pro buttons. When OBS runs on the
  same computer, it reads Replay Buffer Pro's own settings file (`save_button_settings.json` in OBS's
  `plugin_config/replay-buffer-pro` folder), so customised buttons are picked up automatically.
- **Button 1–6**: always triggers that button. Use this for a remote or portable OBS install with
  customised buttons.

The key's settings panel shows which button it will trigger.

Before triggering a save, the key checks that OBS is connected, that the replay buffer is running and
that the buffer is long enough for the clip. If any check fails, the key shows the Stream Deck warning
triangle instead of Replay Buffer Pro popping up a dialog in OBS. Details go to the plugin's log (in the
Stream Deck plugins folder, under `com.replay-buffer-pro.obs.sdPlugin/logs`).

## Security and privacy

- The plugin only connects to the OBS WebSocket server you configure. It has no telemetry and makes no
  other network requests.
- The OBS password is stored in Stream Deck's plugin settings and is never written to the log. OBS
  authentication is challenge-response, so the password itself never crosses the network.
- OBS's WebSocket server doesn't support encryption, so the rest of the traffic is unencrypted. If OBS runs
  on another computer, keep it on a network you trust.
- The only file the plugin reads outside its own folder is Replay Buffer Pro's `save_button_settings.json`.

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run build      # bundle src/ into com.replay-buffer-pro.obs.sdPlugin/bin
npm run watch      # rebuild on change and restart the plugin in Stream Deck
npm test           # build, then run the end-to-end test against a fake Stream Deck and OBS
npm run typecheck
npm run validate   # check the manifest and assets with the Stream Deck CLI
npm run icons      # re-render the key images and docs/key-preview.png from src/icons.ts
npm run pack       # build + create dist/com.replay-buffer-pro.obs.streamDeckPlugin
```

To try your build in the Stream Deck app, link the plugin folder once with
`npx streamdeck link com.replay-buffer-pro.obs.sdPlugin`.

| Path | Purpose |
| --- | --- |
| `src/plugin.ts` | Entry point: registers the actions and wires up settings and the settings panel. |
| `src/obs.ts` | Keeps the OBS connection alive, reconnects and tracks the replay buffer state. |
| `src/obs-websocket.ts` | Minimal obs-websocket v5 client on top of Node's built-in WebSocket. |
| `src/replay-buffer-pro.ts` | Maps a clip length to a Replay Buffer Pro hotkey. |
| `src/actions/` | The toggle and save actions. |
| `src/icons.ts` | SVG artwork for all images, rendered to PNG by `scripts/render-icons.ts`. |
| `com.replay-buffer-pro.obs.sdPlugin/ui/settings.html` | Settings panel (property inspector). |
| `test/e2e.mjs` | End-to-end test. |

### Releasing

1. Bump `version` in `package.json` and `Version` in the manifest.
2. Push a tag like `v1.0.1`. CI tests the plugin, packs it with that version, and attaches the
   `.streamDeckPlugin` file to a new GitHub release.

## Third-party code

`com.replay-buffer-pro.obs.sdPlugin/ui/sdpi-components.js` is
[sdpi-components](https://sdpi-components.dev) v4.0.1 (MIT, © Corsair Memory Inc.), which bundles
[Lit](https://lit.dev) (BSD-3-Clause, © Google LLC). It's vendored so the settings panel works offline.
Its license notices are kept in the file header.

This project is not affiliated with OBS, Elgato or the author of Replay Buffer Pro.

## License

[MIT](LICENSE) © jerptrs
