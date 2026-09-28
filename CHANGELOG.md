# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-09-28

### Added

- Upload saved clips to a [chibisafe](https://github.com/chibisafe/chibisafe) server and copy the link to the
  clipboard. Set it up in the Replay Buffer On/Off key's settings: server URL, API key and a switch that turns
  uploading on for all save keys. The status line checks the connection before you switch uploading on.
- Save keys show **UPLOADING** with the upload's progress, then **LINK COPIED**. Clips are streamed from disk,
  so even a 1 GB clip needs only a few dozen MB of memory.
- A default album for uploaded clips, picked by name from a dropdown that loads your chibisafe albums
  (↻ reloads it).
- Per-key upload settings: **Upload clips from this key** to opt a key out, and **Album** to send its clips to
  a different album or to none.
- Large clips are uploaded in chunks, and chibisafe servers that store files on S3 are supported. Clips over the
  server's size limit are refused before anything is sent.
- Only the trimmed clip from Replay Buffer Pro is uploaded, and only for saves made with a Stream Deck key. If the
  trim fails, the clip is too large or the server can't be reached, the key shows the warning triangle and the
  plugin's log says why.
- The chibisafe API key is only sent over HTTPS (unless the server is on your local network), requests carrying
  it never follow redirects, and it never appears in the log.
- Contributing guide, code of conduct, security policy and issue forms.

### Changed

- While OBS isn't running, the plugin retries the connection less often: after 5 seconds at first, slowing down to
  once a minute. Pressing a key still reconnects immediately.
- The development instructions moved from the README to [CONTRIBUTING.md](CONTRIBUTING.md).
- GitHub release notes now come from this changelog.
- The install steps in the README now start with installing Replay Buffer Pro.

## [1.1.0] - 2026-09-28

### Added

- **Save Last 5 min**, **Save Last 15 min** and **Save Last 30 min** keys, matching Replay Buffer Pro's buttons
  4 to 6.

### Changed

- A save key now waits up to 2 minutes, instead of 30 seconds, for OBS to confirm a save, since OBS writes the
  whole replay buffer before Replay Buffer Pro trims it.

## [1.0.1] - 2026-09-28

### Changed

- The OBS connection uses Node.js's built-in WebSocket, so the plugin depends on nothing but Elgato's Stream Deck
  SDK.
- The plugin code is no longer minified, so errors in the log are readable.

## [1.0.0] - 2026-09-28

### Added

- **Replay Buffer On/Off** key that starts or stops OBS's replay buffer and shows whether it's running. In a
  multi-action, its On and Off states always start or stop the buffer.
- **Save Last 15 sec**, **Save Last 30 sec** and **Save Last 60 sec** keys that run Replay Buffer Pro's save
  actions directly through OBS's WebSocket server, without binding any hotkeys in OBS.
- Each save key finds the Replay Buffer Pro button with its length automatically, including customised buttons
  when OBS runs on the same computer, or can be set to a specific button.
- Before saving, the keys check that OBS is connected, the replay buffer is running and the buffer is long enough,
  and show the Stream Deck warning triangle instead of Replay Buffer Pro's pop-up in OBS.
- Settings panel for the OBS WebSocket host, port and password, with a connection status line.

[Unreleased]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/releases/tag/v1.0.0
