//! Baethoven desktop shell.
//!
//! Wraps the bundled Baethoven web app (`../web`) in a native window and gates it
//! behind a Killavic Cheat Codes sign-in:
//!
//! 1. On launch we look for a stored JWT (tauri-plugin-store, `auth.json`).
//! 2. If present, we validate it against `GET /api/baethoven-check`. `{ unlocked: true }`
//!    shows the main app window; anything else clears the JWT and shows the auth window.
//! 3. If absent (or invalid), the auth window opens. "Sign In" generates a random
//!    `state` nonce, stashes it, and opens the KCC desktop-auth page in the user's
//!    default browser as `…/baethoven-desktop-auth?desktop=1&state=<nonce>` (the
//!    bridge REQUIRES both params — a bare URL renders "link invalid or expired").
//!    The browser deep-links back as `baethoven://auth?code=xxx&state=<nonce>`; we
//!    verify the returned state matches the nonce we generated, then exchange
//!    `{ code, state }` at `POST /api/baethoven/desktop-token` for a JWT, store it,
//!    and swap to the main window.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

const API_BASE: &str = "https://killaviccheatcodes.app";
const AUTH_BROWSER_URL: &str = "https://killaviccheatcodes.app/baethoven-desktop-auth";
const STORE_FILE: &str = "auth.json";
const JWT_KEY: &str = "jwt";

// ---------------------------------------------------------------------------
// Auth state — the per-launch sign-in nonce (CSRF / replay protection)
// ---------------------------------------------------------------------------

/// Holds the cryptographically-random `state` nonce generated when the user
/// starts sign-in. The browser bridge echoes it back in the `baethoven://auth`
/// deep link; `handle_deep_link` verifies the returned value matches before
/// redeeming the one-time code. Managed by Tauri (`Builder::manage`).
#[derive(Default)]
struct AuthState {
    nonce: std::sync::Mutex<Option<String>>,
}

// ---------------------------------------------------------------------------
// Tauri commands (callable from auth.html)
// ---------------------------------------------------------------------------

/// Open the KCC desktop sign-in page in the user's default browser.
///
/// Generates a fresh cryptographically-random `state` nonce, stores it for the
/// deep-link callback to verify against, and includes it (plus `desktop=1`) in
/// the URL. The backend bridge REQUIRES `?desktop=1&state=<nonce>` — without it
/// the page renders a "Sign-in link invalid or expired" error.
#[tauri::command]
fn open_auth_browser(state: tauri::State<'_, AuthState>) -> Result<(), String> {
    // 32 hex chars — matches the bridge's /^[A-Za-z0-9_-]{16,128}$/ and is URL-safe.
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    *state
        .nonce
        .lock()
        .map_err(|_| "auth state lock poisoned".to_string())? = Some(nonce.clone());
    let url = format!("{AUTH_BROWSER_URL}?desktop=1&state={nonce}");
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Clear the stored JWT and return to the auth window.
#[tauri::command]
fn sign_out(app: AppHandle) -> Result<(), String> {
    clear_jwt(&app);
    show_auth(&app);
    Ok(())
}

// ---------------------------------------------------------------------------
// Project save / load (.baethoven files)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct LoadResult {
    contents: String,
    path: String,
}

/// Write a serialized project (`data`, a JSON string) to disk.
///
/// `path` present  -> overwrite that file in place (Cmd+S on an already-saved project).
/// `path` absent   -> open a native "Save As" dialog filtered to `.baethoven`.
/// Returns the path written, so the webview can remember it for the next Cmd+S.
/// Cancelling the dialog returns `Err("cancelled")` (the webview ignores it).
///
/// `async` so it runs off the main thread — the blocking dialog dispatches its
/// UI to the main thread and would deadlock if called from there.
#[tauri::command]
async fn save_project(app: AppHandle, path: Option<String>, data: String) -> Result<String, String> {
    let target = match path {
        Some(p) if !p.is_empty() => std::path::PathBuf::from(p),
        _ => {
            let picked = app
                .dialog()
                .file()
                .add_filter("Baethoven Project", &["baethoven"])
                .set_file_name("Untitled.baethoven")
                .blocking_save_file();
            match picked {
                Some(fp) => fp.into_path().map_err(|e| e.to_string())?,
                None => return Err("cancelled".into()),
            }
        }
    };
    std::fs::write(&target, data).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Open a native file picker filtered to `.baethoven` and return the chosen
/// file's contents plus its path. Cancelling returns `Err("cancelled")`.
#[tauri::command]
async fn load_project(app: AppHandle) -> Result<LoadResult, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Baethoven Project", &["baethoven"])
        .blocking_pick_file();
    let fp = match picked {
        Some(fp) => fp,
        None => return Err("cancelled".into()),
    };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(LoadResult {
        contents,
        path: path.to_string_lossy().to_string(),
    })
}

// ---------------------------------------------------------------------------
// JWT storage helpers
// ---------------------------------------------------------------------------

fn get_jwt(app: &AppHandle) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    store.get(JWT_KEY)?.as_str().map(|s| s.to_string())
}

fn set_jwt(app: &AppHandle, jwt: &str) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.set(JWT_KEY, json!(jwt));
        let _ = store.save();
    }
}

fn clear_jwt(app: &AppHandle) {
    if let Ok(store) = app.store(STORE_FILE) {
        store.delete(JWT_KEY);
        let _ = store.save();
    }
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

/// Reveal the main app window and dispose of the auth window.
fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(auth) = app.get_webview_window("auth") {
        let _ = auth.close();
    }
}

/// Hide the main app window and show (or create) the auth window.
fn show_auth(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    if let Some(auth) = app.get_webview_window("auth") {
        let _ = auth.show();
        let _ = auth.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "auth", WebviewUrl::App("auth.html".into()))
        .title("Baethoven")
        .inner_size(480.0, 600.0)
        .min_inner_size(390.0, 560.0)
        .resizable(false)
        .center()
        .build();
}

/// Surface an error message inside the auth window.
fn auth_error(app: &AppHandle, msg: &str) {
    if let Some(auth) = app.get_webview_window("auth") {
        let safe = serde_json::to_string(msg).unwrap_or_else(|_| "\"Sign-in failed.\"".into());
        let _ = auth.eval(&format!(
            "window.showAuthError && window.showAuthError({});",
            safe
        ));
    }
}

// ---------------------------------------------------------------------------
// Backend calls
// ---------------------------------------------------------------------------

/// Validate a stored JWT. Returns true only on an explicit `{ unlocked: true }`.
fn validate_jwt(jwt: &str) -> bool {
    let client = match reqwest::blocking::Client::builder().build() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let resp = client
        .get(format!("{API_BASE}/api/baethoven-check"))
        .bearer_auth(jwt)
        .send();
    match resp.and_then(|r| r.json::<Value>()) {
        Ok(v) => v.get("unlocked").and_then(Value::as_bool).unwrap_or(false),
        Err(_) => false,
    }
}

/// Exchange a one-time auth code (+ its `state` nonce) for a JWT. The backend
/// requires BOTH fields. Accepts `jwt`, `token`, or `access_token` in the reply.
fn exchange_code(code: &str, state: &str) -> Option<String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(format!("{API_BASE}/api/baethoven/desktop-token"))
        .json(&json!({ "code": code, "state": state }))
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().ok()?;
    for key in ["jwt", "token", "access_token"] {
        if let Some(s) = body.get(key).and_then(Value::as_str) {
            return Some(s.to_string());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/// Handle a `baethoven://auth?code=xxx&state=yyy` callback from the browser flow.
fn handle_deep_link(app: &AppHandle, url: &tauri::Url) {
    if url.scheme() != "baethoven" {
        return;
    }
    let is_auth = url.host_str() == Some("auth") || url.path().contains("auth");
    if !is_auth {
        return;
    }

    let mut code = None;
    let mut state = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }

    let Some(code) = code else {
        auth_error(app, "Sign-in link was missing its code. Please try again.");
        return;
    };
    let Some(state) = state else {
        auth_error(app, "Sign-in link was missing its security token. Please try again.");
        return;
    };

    // Verify the returned state matches the nonce we generated at sign-in start,
    // consuming it on success so the link can't be replayed.
    let verified = {
        let auth = app.state::<AuthState>();
        let mut nonce = match auth.nonce.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if nonce.as_deref() == Some(state.as_str()) {
            *nonce = None;
            true
        } else {
            false
        }
    };
    if !verified {
        auth_error(app, "Sign-in security check failed. Please start sign-in again.");
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || match exchange_code(&code, &state) {
        Some(jwt) => {
            set_jwt(&app, &jwt);
            show_main(&app);
        }
        None => auth_error(&app, "Sign-in failed. Please try again."),
    });
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

/// Check for updates on launch. Non-fatal: a missing/invalid pubkey simply skips.
#[cfg(desktop)]
async fn check_for_updates(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    let updater = match app.updater() {
        Ok(u) => u,
        Err(_) => return,
    };
    if let Ok(Some(update)) = updater.check().await {
        let _ = update.download_and_install(|_, _| {}, || {}).await;
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(AuthState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // WKWebView ships no Web MIDI API. This plugin injects a polyfill that
        // defines `navigator.requestMIDIAccess`, backed by native MIDI (midir),
        // so the bundled web app's `initMidi()` detects USB controllers.
        .plugin(tauri_plugin_midi::init());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_deep_link::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            // Native menu bar. File = Open / Save / Save As; Edit = Undo / Redo.
            // Each item emits a `menu:*` event the webview listens for. Accelerators
            // fire the same events, so Cmd+S / Cmd+O / Cmd+Z work when focused.
            .menu(|handle| {
                use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
                let open = MenuItemBuilder::with_id("open", "Open…")
                    .accelerator("CmdOrCtrl+O")
                    .build(handle)?;
                let save = MenuItemBuilder::with_id("save", "Save")
                    .accelerator("CmdOrCtrl+S")
                    .build(handle)?;
                let save_as = MenuItemBuilder::with_id("save_as", "Save As…")
                    .accelerator("CmdOrCtrl+Shift+S")
                    .build(handle)?;
                let file = SubmenuBuilder::new(handle, "File")
                    .item(&open)
                    .separator()
                    .item(&save)
                    .item(&save_as)
                    .build()?;
                let undo = MenuItemBuilder::with_id("undo", "Undo")
                    .accelerator("CmdOrCtrl+Z")
                    .build(handle)?;
                let redo = MenuItemBuilder::with_id("redo", "Redo")
                    .accelerator("CmdOrCtrl+Shift+Z")
                    .build(handle)?;
                let edit = SubmenuBuilder::new(handle, "Edit")
                    .item(&undo)
                    .item(&redo)
                    .build()?;
                let mb = MenuBuilder::new(handle);
                #[cfg(target_os = "macos")]
                let mb = {
                    let app_menu = SubmenuBuilder::new(handle, "Baethoven")
                        .about(None)
                        .separator()
                        .hide()
                        .hide_others()
                        .show_all()
                        .separator()
                        .quit()
                        .build()?;
                    mb.item(&app_menu).item(&file).item(&edit)
                };
                #[cfg(not(target_os = "macos"))]
                let mb = mb.item(&file).item(&edit);
                mb.build()
            })
            .on_menu_event(|app, event| {
                let name = match event.id().as_ref() {
                    "save" => "menu:save",
                    "save_as" => "menu:save-as",
                    "open" => "menu:open",
                    "undo" => "menu:undo",
                    "redo" => "menu:redo",
                    _ => return,
                };
                let _ = app.emit(name, ());
            });
    }

    builder
        .invoke_handler(tauri::generate_handler![
            open_auth_browser,
            sign_out,
            save_project,
            load_project
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Runtime scheme registration is required on Windows/Linux; macOS
                // registers `baethoven://` from the bundled Info.plist.
                let _ = app.deep_link().register("baethoven");
                let dl_handle = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link(&dl_handle, &url);
                    }
                });

                let up_handle = handle.clone();
                tauri::async_runtime::spawn(check_for_updates(up_handle));
            }

            // Auth gate.
            match get_jwt(&handle) {
                Some(jwt) => {
                    let gate = handle.clone();
                    std::thread::spawn(move || {
                        if validate_jwt(&jwt) {
                            show_main(&gate);
                        } else {
                            clear_jwt(&gate);
                            show_auth(&gate);
                        }
                    });
                }
                None => show_auth(&handle),
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Baethoven");
}
