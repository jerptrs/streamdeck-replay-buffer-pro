# Contributing

Thanks for helping improve OBS Replay Buffer Pro for Stream Deck! Bug reports, ideas and pull requests are all
welcome. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and requesting features

Please search the [existing issues](https://github.com/jerptrs/streamdeck-replay-buffer-pro/issues) first, then
use one of the issue forms:

- [Bug report](https://github.com/jerptrs/streamdeck-replay-buffer-pro/issues/new?template=bug_report.yml): include
  your plugin, Stream Deck, OBS and Replay Buffer Pro versions, and the relevant lines of the plugin log. It's in
  `%APPDATA%\Elgato\StreamDeck\Plugins\com.replay-buffer-pro.obs.sdPlugin\logs` on Windows and
  `~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.replay-buffer-pro.obs.sdPlugin/logs` on macOS.
- [Feature request](https://github.com/jerptrs/streamdeck-replay-buffer-pro/issues/new?template=feature_request.yml):
  describe the problem you want solved, not only the solution.

Problems with OBS, [Replay Buffer Pro](https://github.com/JoshuaPotter/replay-buffer-pro) or
[chibisafe](https://github.com/chibisafe/chibisafe) themselves belong in those projects.

**Security issues:** please don't open a public issue. Follow the [security policy](SECURITY.md) instead.

## Development setup

You need Node.js 24 or newer. To try your changes you also need the Stream Deck app (7.1 or newer), which runs on
Windows and macOS.

```bash
npm install
npm run build      # bundle src/ into com.replay-buffer-pro.obs.sdPlugin/bin
npm run watch      # rebuild on change and restart the plugin in Stream Deck
npm test           # build, then run the end-to-end test against a fake Stream Deck, OBS and chibisafe
npm run typecheck
npm run validate   # build, then check the manifest and assets with the Stream Deck CLI
npm run icons      # re-render the key images and docs/key-preview.png from src/icons.ts
npm run pack       # build + create dist/com.replay-buffer-pro.obs.streamDeckPlugin
```

To run your build in the Stream Deck app, link the plugin folder once with
`npx streamdeck link com.replay-buffer-pro.obs.sdPlugin`. `npm run watch` then restarts the plugin after every
build. If you develop in WSL, where the Stream Deck CLI can't reach the app, run `npm run pack` and double-click
the file in `dist/` instead.

| Path | Purpose |
| --- | --- |
| `src/plugin.ts` | Entry point: registers the actions and wires up settings and the settings panel. |
| `src/obs.ts` | Keeps the OBS connection alive, reconnects and tracks the replay buffer state. |
| `src/obs-app.ts` | Finds and opens OBS for the On/Off key's NO OBS face. |
| `src/obs-websocket.ts` | Minimal obs-websocket v5 client on top of Node's built-in WebSocket. |
| `src/replay-buffer-pro.ts` | Asks Replay Buffer Pro to save a clip, and checks that it's installed and up to date. |
| `src/upload.ts` | Waits for Replay Buffer Pro's trimmed clip, uploads it and copies the link. |
| `src/chibisafe.ts` | chibisafe client: connection check, album list, chunked and S3 uploads. |
| `src/http.ts` | Small HTTP client that streams uploads from disk. |
| `src/clipboard.ts` | Copies text with the OS's clipboard tool. |
| `src/actions/` | The toggle and save actions. |
| `src/icons.ts` | SVG artwork for all images, rendered to PNG by `scripts/render-icons.ts`; custom length keys are drawn from it at runtime. |
| `src/key-images.ts` | Loads the rendered key images for the plugin at runtime, and turns runtime SVG into images. |
| `com.replay-buffer-pro.obs.sdPlugin/ui/settings.html` | Settings panel (property inspector). |
| `test/e2e.mjs` | End-to-end test. |

### Common changes

- **New clip length:** add it to `SAVE_DURATIONS` and `DURATION_ACCENT` in `src/icons.ts`, add a matching action to
  `com.replay-buffer-pro.obs.sdPlugin/manifest.json`, then run `npm run icons`.
- **Artwork:** key images are drawn in `src/icons.ts`. After changing them, run `npm run icons` and commit the
  updated PNGs, including `docs/key-preview.png`. The labels are designed for Arial Bold, which the script picks
  up on Windows, macOS and WSL.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change. Keep each pull request to one change, and follow the style of the surrounding code.
3. Add or update checks in `test/e2e.mjs` when you change behaviour. When users would notice the change, update
   the README and add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
4. Run `npm run typecheck`, `npm run validate` and `npm test`. CI runs the same checks on every pull request.
5. Open the pull request and describe what changed and why. Link the issue it fixes, if there is one.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
