/**
 * Optional auto-update for the packaged Baethoven build (electron-updater).
 *
 * Minimal + fully guarded: it only runs in a packaged app and never throws. To actually
 * deliver updates you must (1) keep the `publish` block in electron-builder.json, (2) sign
 * the build, and (3) host the generated update feed (latest-mac.yml / *.dmg / *.zip on
 * macOS, latest.yml / *.exe on Windows) at that URL. Until then this is a no-op stub.
 */
'use strict';

function check() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch {
    /* electron-updater missing or no publish feed configured — skip silently */
  }
}

module.exports = { check };
