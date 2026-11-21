# Sticker Drawer for Windows

A desktop app for the HeyTea sticker drawer: queue pictures, pick a preset, press **Start**, and watch the phone draw them one after another.

- **Queue.** Drop pictures anywhere in the window or add them with the button; drag to reorder. Each one is auto-matched in the background and shows its stroke count and drawing time.
- **Presets.** Best match, Fine detail, Bold two-tone and Line drawing, plus your own: tune a picture with the Adjust sliders and **Save as preset**.
- **Start.** The app looks at the phone, finds the sticker canvas, the Brush and Eraser buttons and the brush size, and draws. Between pictures it waits for a new empty canvas and carries on by itself.
- **Progress.** Percent, time left, the tool and the strokes drawn, live. **Pause** and **Stop** at any time; a stopped picture resumes where it left off. The drawing also pauses by itself if HeyTea leaves the screen.

It plans with the same engine as the web page and the command line (`../engine.js`, copied in at build time), so all three draw identically.

## Build and run

You need [Rust](https://rustup.rs) (stable, MSVC on Windows) and [Android Platform-Tools](https://developer.android.com/tools/releases/platform-tools) for `adb`. Windows 10 and 11 already have the WebView2 runtime the window uses.

```bash
cd desktop
```

```bash
cargo run --release
```

The app is then at `desktop/target/release/sticker-drawer.exe` and can be copied anywhere. The first build takes several minutes; later ones take seconds. An installer can be made with the Tauri CLI (`cargo install tauri-cli`, then `cargo tauri build`).

`adb` is found on PATH, in the Android SDK, or in a `platform-tools` folder in Downloads; Settings (the gear) takes a path otherwise.

## Using it

1. Connect the phone by USB with USB debugging on. The chip at the top right turns green.
2. Add pictures and pick presets.
3. On the phone, open Create Sticker in HeyTea and pick the **Brush**.
4. Press **Start**. When a picture is done, save it in HeyTea and start a new sticker with the Brush picked: the next one starts by itself.

## How it fits together

| Part | Does |
|---|---|
| `src/main.rs` | the phone: finds `adb`, lists phones, takes screenshots, reads the screen density, sends and runs `draw.sh`, pauses and stops it, saves the queue and presets |
| `ui/` | the window: queue, presets, previews, progress; plans with `vendor/engine.js` in `vendor/worker.js` |
| `build.rs` | copies `../engine.js` and `../worker.js` into `ui/vendor` |

The script reports progress to the app as lines (`@P`, `@PAUSED`, `@WAIT`, `@RUN`, `@DONE`, `@STOPPED`) when `HEYTEA_PROGRESS` is set, and pauses at its next checkpoint while `/sdcard/.heytea-pause` exists. Both are in `engine.js`, so a `draw.sh` from the web page behaves the same when run by hand.

To inspect the window while developing, start it with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` and open `http://127.0.0.1:9333` in Edge or Chrome; `window.__sd` holds the app's state.
