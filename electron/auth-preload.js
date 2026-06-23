/**
 * Preload for the auth (sign-in) window. Exposes a minimal bridge so auth.html can start the
 * browser sign-in flow and receive error messages from the main process. NO desktop-unlock
 * flag is exposed here — this window is the pre-license gate.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('baethovenAuth', {
  signIn: () => ipcRenderer.invoke('license:startBrowserSignIn'),
  onError: (handler) => {
    const listener = (_e, msg) => handler(msg);
    ipcRenderer.on('auth:error', listener);
    return () => ipcRenderer.removeListener('auth:error', listener);
  },
});
