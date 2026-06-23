/**
 * Baethoven desktop shell — Electron MAIN process.
 *
 * Why Electron (replacing the Tauri scaffold in ../src-tauri): WKWebView has no native Web
 * MIDI and adds audio latency. Chromium ships native Web MIDI, so the bundle's existing
 * `navigator.requestMIDIAccess` works with zero plugin — we only have to auto-grant the
 * 'midi'/'midiSysex' session permissions below.
 *
 * Window model mirrors the Tauri build (src-tauri/src/lib.rs):
 *   - On launch, checkLicense() re-validates the stored device token against the KCC backend.
 *   - Unlocked → main window loads ../web/index.html with preload.js, which exposes the
 *     truthy `window.__BAETHOVEN_DESKTOP__` flag the bundle reads to (a) unlock exports and
 *     (b) use the low-latency AudioContext. The flag is ONLY present in this gated window,
 *     so a download alone never unlocks exports.
 *   - Locked → auth window loads auth.html (sign-in UI), which kicks off the browser deep-link
 *     flow handled in license.js.
 */
'use strict';

const {
  app, BrowserWindow, session, ipcMain, globalShortcut,
} = require('electron');
const path = require('path');
const license = require('./license');

// --- Chromium switches (must be set BEFORE app is ready) -------------------------------
// Native Web MIDI + status API, and let the AudioContext start without a user gesture so
// the bundle's audio engine spins up immediately.
app.commandLine.appendSwitch('enable-features', 'WebMIDI,WebMIDIGetStatusAPI');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const isDev = !app.isPackaged;
const WEB_INDEX = path.join(__dirname, '..', 'web', 'index.html');

let mainWindow = null;
let authWindow = null;
let pendingAuthLink = null; // cold-start baethoven:// link (Windows/Linux argv)

// --- Single-instance lock --------------------------------------------------------------
// A 2nd launch (or an OS deep-link dispatch) must hand its URL to the running instance,
// not spin up a second app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  registerProtocol();
  wireDeepLinks();
  wireIpc();

  // Cold-start deep link (Windows/Linux pass it in argv; macOS replays 'open-url').
  const argvLink = process.argv.find((a) => a.startsWith('baethoven://'));
  if (argvLink) pendingAuthLink = argvLink;

  app.whenReady().then(onReady);
}

// --- Custom protocol registration ------------------------------------------------------
function registerProtocol() {
  if (process.defaultApp) {
    // Dev: `electron .` — tell the OS how to relaunch us for a deep link.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('baethoven', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('baethoven');
  }
}

// --- Deep-link wiring ------------------------------------------------------------------
function wireDeepLinks() {
  // macOS delivers baethoven:// via 'open-url'.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleAuthDeepLink(url);
  });

  // Windows/Linux deliver it to the already-running instance via 'second-instance' argv.
  app.on('second-instance', (_event, argv) => {
    const link = argv.find((a) => a.startsWith('baethoven://'));
    if (link) handleAuthDeepLink(link);
    const w = mainWindow || authWindow;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
}

/** Parse + validate a baethoven://auth?code=…&state=… callback and complete sign-in. */
function handleAuthDeepLink(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return; }
  if (parsed.protocol !== 'baethoven:' || parsed.host !== 'auth') return;
  const code = parsed.searchParams.get('code') || '';
  const state = parsed.searchParams.get('state') || '';
  // base64url shapes — reject anything malformed before hitting the network.
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(code) || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return;

  void license.handleAuthCallback(code, state).then((res) => {
    if (res && res.ok) {
      createMainWindow(); // closes the auth window
    } else if (authWindow) {
      authWindow.webContents.send('auth:error', (res && res.error) || 'Sign-in failed. Please try again.');
    }
  });
}

// --- IPC (renderer → main) -------------------------------------------------------------
function wireIpc() {
  ipcMain.handle('license:startBrowserSignIn', () => { license.startBrowserSignIn(); });
  ipcMain.handle('license:check', () => license.checkLicense());
  ipcMain.handle('license:openBuyPage', () => { license.openBuyPage(); });
  ipcMain.handle('license:signOut', () => {
    license.signOut();
    if (mainWindow) { mainWindow.close(); mainWindow = null; }
    createAuthWindow();
  });
}

// --- Windows ---------------------------------------------------------------------------
function createMainWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 390,
    minHeight: 600,
    backgroundColor: '#111111',
    title: 'Baethoven',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep audio + MIDI timers running when the window is backgrounded (mirrors the
      // Tauri build's backgroundThrottling:"disabled").
      backgroundThrottling: false,
      devTools: isDev,
    },
  });
  mainWindow.webContents.on('did-finish-load', () => console.log('[baethoven] main window loaded:', WEB_INDEX));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => console.error('[baethoven] main load failed:', code, desc));
  mainWindow.loadFile(WEB_INDEX);
  mainWindow.on('closed', () => { mainWindow = null; });

  if (authWindow) { authWindow.close(); authWindow = null; }
}

function createAuthWindow() {
  if (authWindow) { authWindow.show(); authWindow.focus(); return; }
  authWindow = new BrowserWindow({
    width: 480,
    height: 600,
    minWidth: 390,
    minHeight: 560,
    resizable: false,
    backgroundColor: '#f5f0e8',
    title: 'Baethoven',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'auth-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev,
    },
  });
  authWindow.loadFile(path.join(__dirname, 'auth.html'));
  authWindow.on('closed', () => { authWindow = null; });
}

// --- Launch ----------------------------------------------------------------------------
async function onReady() {
  // Auto-grant Web MIDI (and media, for future recording) without a prompt.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'midi', 'midiSysex'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'midi', 'midiSysex'].includes(permission));

  // Dev-only DevTools toggle.
  if (isDev) {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const w = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      w?.webContents.toggleDevTools();
    });
  }

  // License gate. BAETHOVEN_DEV_UNLOCK=1 skips the network check to load the main bundle
  // directly — DEV/TEST ONLY (it does not write a token; exports unlock only because the
  // gated window exposes the desktop flag).
  const devUnlock = process.env.BAETHOVEN_DEV_UNLOCK === '1';
  let unlocked = devUnlock;
  if (!devUnlock) {
    try { unlocked = (await license.checkLicense()).unlocked === true; } catch { unlocked = false; }
  }
  console.log('[baethoven] license gate:', unlocked ? 'unlocked → main window' : 'locked → auth window');
  if (unlocked) createMainWindow(); else createAuthWindow();

  // Flush a cold-start deep link now that a window exists.
  if (pendingAuthLink) { handleAuthDeepLink(pendingAuthLink); pendingAuthLink = null; }

  // Packaged auto-update (no-op in dev / when the publish feed is unreachable).
  if (app.isPackaged) {
    try { require('./updater').check(); } catch { /* updater optional */ }
  }
}

// --- App lifecycle ---------------------------------------------------------------------
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) onReady();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
