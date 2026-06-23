/**
 * Preload for the MAIN (unlocked) Baethoven window.
 *
 * Exposes a single global the bundle reads to know it's the desktop build:
 *   window.__BAETHOVEN_DESKTOP__   (a truthy object — replaces the Tauri `window.__TAURI__`
 *                                   checks the bundle uses for the export gate + low-latency
 *                                   AudioContext; the bundle now accepts EITHER flag).
 *
 * It is only injected here, in the window the main process loads AFTER the license check,
 * so its mere presence = "this user is entitled" (same trust model as the Tauri build).
 * The object also carries a couple of convenience calls for a future sign-out / buy menu.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__BAETHOVEN_DESKTOP__', {
  platform: process.platform,
  signOut: () => ipcRenderer.invoke('license:signOut'),
  openBuyPage: () => ipcRenderer.invoke('license:openBuyPage'),
  onMenuEvent: (name, fn) => ipcRenderer.on(name, (_e, ...args) => fn(...args)),
  saveProject: (filePath, data) => ipcRenderer.invoke('project:save', filePath, data),
  loadProject: () => ipcRenderer.invoke('project:load'),
});
