# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- When OBS, opened from the On/Off key, took longer than a minute to start (for example because of a dialog), the
  plugin could need up to another minute to connect once OBS was up.
- If the plugin can't check whether OBS is already running, the log now says so before it opens OBS.

## [2.1.0] - 2026-10-04

### Added

- Pressing the On/Off key while it shows **NO OBS** starts OBS. This works when OBS is installed on the same
  computer as Stream Deck, not when the plugin connects to OBS on another computer. The plugin then tries to
  connect every 2 seconds for up to a minute. Standard and Steam installs are found
  by themselves; set **OBS app** in the key's settings for others, such as a portable OBS. If OBS is already
  running but can't be reached, the key shows the warning triangle and the log says what to check.
- While OBS is starting up, the On/Off key shows **STARTING OBS** until OBS has finished loading and its window
  is open. This also happens when you start OBS yourself, not only from the key. Save keys pressed during that
  time show the warning triangle.

### Fixed

- Connecting while OBS was still starting could leave the On/Off key on **DISABLED**, because OBS answers "not
  ready" until it has loaded. The plugin now waits for OBS to be ready.
- When the plugin connects, the On/Off key goes straight to the replay buffer's state instead of briefly
  showing OFF.
- The README's tip for tighter clips now also says where OBS keeps the keyframe interval when recording uses the
  stream encoder (the Streaming tab).

## [2.0.0] - 2026-10-04

### Added

- **Save Custom Length** key: saves the last 1 second to 6 hours. Set the length as a whole number of seconds,
  minutes or hours, and the key's colour, in its settings. The key shows the length you entered, in the same
  style as the other save keys, and uploads to chibisafe like them.

### Changed

- **Requires Replay Buffer Pro 1.8.0 or newer**, and so OBS Studio 32.2 or newer. The settings panel's status
  line says when Replay Buffer Pro is missing or too old.
- Save keys ask Replay Buffer Pro to save with its new `SaveClip` request instead of running its save buttons'
  hotkeys. The keys no longer depend on the lengths of Replay Buffer Pro's own buttons.
- A key longer than the replay buffer saves the whole buffer instead of showing the warning triangle. The log
  says when a clip was shortened.
- When Replay Buffer Pro refuses a save, for example while recording is paused, the key shows the warning
  triangle and the log says why.
- A key press sends one request to OBS instead of three.
- The README explains why clips can be a little longer than the key says (Replay Buffer Pro cuts at keyframes)
  and how to make them tighter.

### Removed

- The **OBS button** setting of the save keys. The plugin no longer reads Replay Buffer Pro's settings file.

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

[Unreleased]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jerptrs/streamdeck-replay-buffer-pro/releases/tag/v1.0.0
