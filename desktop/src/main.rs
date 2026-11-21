// Sticker Drawer desktop app: the Rust side talks to the phone over ADB; the UI (ui/, a webview) plans the
// drawings with the shared engine.js and calls these commands.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const REMOTE_SCRIPT: &str = "/sdcard/draw.sh";
const REMOTE_PAUSE: &str = "/sdcard/.heytea-pause";
const REMOTE_PROGRESS: &str = "/sdcard/.heytea-draw-progress";

#[derive(Default)]
struct AppState {
    adb: Mutex<String>,
    job: Arc<Mutex<Option<Child>>>,
}

#[derive(Serialize)]
struct Device {
    serial: String,
    state: String,
    model: String,
}

// an adb command, without a console window flashing up on Windows
fn adb_cmd(adb: &str) -> Command {
    let mut c = Command::new(adb);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

fn works(adb: &str) -> bool {
    adb_cmd(adb).arg("version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

// adb: the one given, else on PATH, else the Android SDK, else a platform-tools folder in Downloads
fn find_adb(custom: &str) -> Option<String> {
    if !custom.trim().is_empty() {
        return works(custom.trim()).then(|| custom.trim().to_string());
    }
    if works("adb") {
        return Some("adb".into());
    }
    let mut places: Vec<PathBuf> = vec![];
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        places.push(PathBuf::from(l).join("Android/Sdk/platform-tools/adb.exe"));
    }
    if let Ok(h) = std::env::var("USERPROFILE") {
        let dl = PathBuf::from(h).join("Downloads");
        places.push(dl.join("platform-tools/adb.exe"));
        if let Ok(rd) = std::fs::read_dir(&dl) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if name.starts_with("platform-tools") {
                    places.push(e.path().join("platform-tools/adb.exe"));
                    places.push(e.path().join("adb.exe"));
                }
            }
        }
    }
    places.into_iter().find(|p| p.exists()).map(|p| p.to_string_lossy().to_string()).filter(|p| works(p))
}

fn adb(state: &State<AppState>) -> Result<String, String> {
    let a = state.adb.lock().unwrap().clone();
    if a.is_empty() {
        Err("adb was not found. Install Android Platform-Tools, or set its path in Settings.".into())
    } else {
        Ok(a)
    }
}

fn run(adb: &str, args: &[&str]) -> Result<std::process::Output, String> {
    adb_cmd(adb).args(args).output().map_err(|e| format!("could not run adb: {e}"))
}

#[tauri::command]
fn set_adb(state: State<AppState>, custom: String) -> Result<String, String> {
    match find_adb(&custom) {
        Some(a) => {
            *state.adb.lock().unwrap() = a.clone();
            Ok(a)
        }
        None => {
            *state.adb.lock().unwrap() = String::new();
            Err(if custom.trim().is_empty() { "adb was not found on this computer.".into() } else { format!("{custom} doesn't run as adb.") })
        }
    }
}

#[tauri::command]
fn devices(state: State<AppState>) -> Result<Vec<Device>, String> {
    let a = adb(&state)?;
    let out = run(&a, &["devices", "-l"])?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty() && !l.starts_with('*'))
        .map(|l| {
            let mut parts = l.split_whitespace();
            let serial = parts.next().unwrap_or("").to_string();
            let st = parts.next().unwrap_or("").to_string();
            let model = l.split_whitespace().find_map(|w| w.strip_prefix("model:")).unwrap_or("").replace('_', " ");
            Device { serial, state: st, model }
        })
        .collect())
}

// the phone's screen as a base64 PNG
#[tauri::command]
fn screenshot(state: State<AppState>, serial: String) -> Result<String, String> {
    let a = adb(&state)?;
    let out = run(&a, &["-s", &serial, "exec-out", "screencap", "-p"])?;
    if !out.status.success() || out.stdout.len() < 100 {
        return Err("could not take a screenshot of the phone".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(&out.stdout))
}

#[tauri::command]
fn screen_dpi(state: State<AppState>, serial: String) -> Result<u32, String> {
    let a = adb(&state)?;
    let out = run(&a, &["-s", &serial, "shell", "wm", "density"])?;
    let text = String::from_utf8_lossy(&out.stdout);
    let pick = |key: &str| text.lines().find_map(|l| l.trim().strip_prefix(key).and_then(|v| v.trim().parse::<u32>().ok()));
    Ok(pick("Override density:").or_else(|| pick("Physical density:")).unwrap_or(0))
}

// the id and checkpoint of a drawing that was stopped on the phone, if any ("<id> <checkpoint> <per mille> <tool>")
#[tauri::command]
fn phone_progress(state: State<AppState>, serial: String) -> Result<String, String> {
    let a = adb(&state)?;
    let out = run(&a, &["-s", &serial, "shell", &format!("cat {REMOTE_PROGRESS} 2>/dev/null")])?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// send a script (or reuse the one on the phone) and run it; its machine lines (@P, @PAUSED, @WAIT, @RUN,
// @DONE, @STOPPED) arrive as "job-line" events, then "job-end" with the exit code
#[tauri::command]
fn start_job(app: AppHandle, state: State<AppState>, serial: String, script: Option<String>, resume: bool) -> Result<(), String> {
    let a = adb(&state)?;
    if state.job.lock().unwrap().is_some() {
        return Err("a drawing is already running".into());
    }
    let _ = run(&a, &["-s", &serial, "shell", &format!("rm -f {REMOTE_PAUSE}")]);
    if let Some(text) = script {
        let tmp = std::env::temp_dir().join(format!("sticker-drawer-{}.sh", std::process::id()));
        std::fs::write(&tmp, text).map_err(|e| format!("could not write the script: {e}"))?;
        let out = run(&a, &["-s", &serial, "push", &tmp.to_string_lossy(), REMOTE_SCRIPT]);
        let _ = std::fs::remove_file(&tmp);
        let out = out?;
        if !out.status.success() {
            return Err(format!("could not send the drawing to the phone: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
    }
    let remote = format!("HEYTEA_PROGRESS=1 sh {REMOTE_SCRIPT}{}", if resume { " resume" } else { "" });
    let mut child = adb_cmd(&a)
        .args(["-s", &serial, "shell", &remote])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start the drawing: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    *state.job.lock().unwrap() = Some(child);
    let job = state.job.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut line = Vec::new();
        loop {
            let n = match stdout.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
            for &b in &buf[..n] {
                if b == b'\n' || b == b'\r' {
                    if line.first() == Some(&b'@') {
                        let _ = app.emit("job-line", String::from_utf8_lossy(&line).trim().to_string());
                    }
                    line.clear();
                } else {
                    line.push(b);
                }
            }
        }
        let code = job.lock().unwrap().take().and_then(|mut c| c.wait().ok()).and_then(|s| s.code()).unwrap_or(-1);
        let _ = app.emit("job-end", code);
    });
    Ok(())
}

#[tauri::command]
fn pause_job(state: State<AppState>, serial: String, on: bool) -> Result<(), String> {
    let a = adb(&state)?;
    let cmd = if on { format!("touch {REMOTE_PAUSE}") } else { format!("rm -f {REMOTE_PAUSE}") };
    run(&a, &["-s", &serial, "shell", &cmd]).map(|_| ())
}

// stop: TERM makes the script put the screen setting back and keep its checkpoint for resuming
#[tauri::command]
fn stop_job(state: State<AppState>, serial: String) -> Result<(), String> {
    let a = adb(&state)?;
    let _ = run(&a, &["-s", &serial, "shell", &format!("rm -f {REMOTE_PAUSE}; pkill -TERM -f draw_lf.sh; pkill -TERM -f '{REMOTE_SCRIPT}'")]);
    let job = state.job.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        if let Some(c) = job.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    });
    Ok(())
}

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.json"))
}

#[tauri::command]
fn load_state(app: AppHandle) -> Result<String, String> {
    Ok(std::fs::read_to_string(state_file(&app)?).unwrap_or_default())
}

#[tauri::command]
fn save_state(app: AppHandle, json: String) -> Result<(), String> {
    let f = state_file(&app)?;
    let tmp = f.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &f).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            set_adb, devices, screenshot, screen_dpi, phone_progress, start_job, pause_job, stop_job, load_state, save_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
