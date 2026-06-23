/**
 * Desktop licensing for the Baethoven Electron build — MAIN process (all secrets + state).
 *
 * Browser-only sign-in (a faithful port of Terminator's desktopLicense.ts, retargeted at
 * the Baethoven backend routes). There is no in-app password form and no Supabase token in
 * the renderer. We open the KCC bridge in the default browser with a one-time nonce; the
 * browser deep-links a one-time CODE back via baethoven://auth; we trade the code for a
 * long-lived, server-signed DEVICE TOKEN and store it encrypted with Electron safeStorage
 * (OS keychain) under userData. The renderer never sees the code or the token.
 *
 * checkLicense() re-validates with the server every launch, so a revoked purchase or a
 * lapsed subscription re-locks the app even though the device token itself is long-lived.
 * A 7-day offline grace (off the last successful validation) keeps paying users working
 * without a connection.
 *
 * Backend (subscription-starter):
 *   GET  /baethoven-desktop-auth?desktop=1&state=<nonce>   (browser bridge)
 *   POST /api/baethoven/desktop-token   { code, state } -> { token, email }
 *   GET  /api/baethoven-check           Bearer <token>   -> { unlocked, email }
 */
'use strict';

const { app, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const KCC_BASE = 'https://killaviccheatcodes.app';
const SIGNIN_URL = (state) =>
  `${KCC_BASE}/baethoven-desktop-auth?desktop=1&state=${encodeURIComponent(state)}`;
const TOKEN_URL = `${KCC_BASE}/api/baethoven/desktop-token`;
const CHECK_URL = `${KCC_BASE}/api/baethoven-check`;
const BUY_URL = `${KCC_BASE}/baethoven`;

const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const licensePath = () => path.join(app.getPath('userData'), 'baethoven-license.bin');

// The single in-flight sign-in nonce. Generated when the user clicks "Sign in"; the
// deep-link callback must echo it back EXACTLY. In-memory only — a cold-start deep link
// (app wasn't running) or a foreign/forged baethoven:// link has no matching pending
// nonce and is rejected, so it can never complete sign-in.
let pendingNonce = null;

function readStored() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const obj = JSON.parse(safeStorage.decryptString(fs.readFileSync(licensePath())));
    if (obj && typeof obj.token === 'string' && obj.token) {
      return {
        token: obj.token,
        email: typeof obj.email === 'string' ? obj.email : '',
        lastValidatedAt: typeof obj.lastValidatedAt === 'number' ? obj.lastValidatedAt : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeStored(lic) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false; // fail closed — never plaintext
    fs.writeFileSync(licensePath(), safeStorage.encryptString(JSON.stringify(lic)));
    return true;
  } catch {
    return false;
  }
}

function clearStored() {
  try { fs.rmSync(licensePath(), { force: true }); } catch { /* nothing stored */ }
}

/** Open the KCC browser sign-in with a fresh one-time nonce. */
function startBrowserSignIn() {
  pendingNonce = crypto.randomBytes(24).toString('base64url'); // 32 chars ∈ [A-Za-z0-9_-]
  void shell.openExternal(SIGNIN_URL(pendingNonce));
}

/** Open the buy page in the default browser. */
function openBuyPage() {
  void shell.openExternal(BUY_URL);
}

/** Clear the stored device token + any pending sign-in. */
function signOut() {
  pendingNonce = null;
  clearStored();
}

/**
 * baethoven://auth callback: verify the nonce, trade the code for a device token, store it
 * encrypted. Returns { ok: true, email } on success or { ok: false, error } so the caller
 * (main.js) can swap windows / surface the message. Never throws.
 */
async function handleAuthCallback(code, state) {
  // The state MUST match the nonce WE generated for an in-flight sign-in. A foreign/forged
  // or cold-start baethoven:// link has no match → reject.
  if (!pendingNonce || state !== pendingNonce) {
    pendingNonce = null;
    return { ok: false, error: 'Sign-in security check failed. Please start sign-in again.' };
  }
  pendingNonce = null; // single-use

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    });
    if (!res.ok) return { ok: false, error: 'Sign-in failed. Please try again.' };
    const data = await res.json().catch(() => null);
    // The route returns { token, email }; accept jwt/access_token too for parity with Tauri.
    const token = data && (data.token || data.jwt || data.access_token);
    if (!token) return { ok: false, error: 'Sign-in failed. Please try again.' };
    const email = (data && data.email) || '';
    const ok = writeStored({ token, email, lastValidatedAt: Date.now() });
    if (!ok) return { ok: false, error: 'Secure storage is unavailable on this device.' };
    return { ok: true, email };
  } catch {
    return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
  }
}

/** Re-validate entitlement with the server. Called on every launch + after sign-in. */
async function checkLicense() {
  const stored = readStored();
  if (!stored) return { unlocked: false, email: '' };

  try {
    const res = await fetch(CHECK_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${stored.token}` },
    });

    // Reachable + definitively not entitled (bad/expired token, revoked, lapsed)
    // → drop the token and lock.
    if (res.status === 401 || res.status === 403) {
      clearStored();
      return { unlocked: false, email: '' };
    }

    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.unlocked === true) {
        const email = data.email || stored.email;
        writeStored({ token: stored.token, email, lastValidatedAt: Date.now() });
        return { unlocked: true, email };
      }
      // Reachable + unlocked:false → revoked / lapsed → lock.
      clearStored();
      return { unlocked: false, email: '' };
    }

    // Reachable but the server couldn't answer (5xx / misconfig): don't punish the user or
    // drop the token — fall back to the offline grace window.
    return offlineGrace(stored);
  } catch {
    // Network unreachable → 7-day offline grace off the last good validation.
    return offlineGrace(stored);
  }
}

function offlineGrace(stored) {
  if (Date.now() - stored.lastValidatedAt <= OFFLINE_GRACE_MS) {
    return { unlocked: true, email: stored.email };
  }
  return { unlocked: false, email: '' };
}

module.exports = {
  startBrowserSignIn,
  openBuyPage,
  signOut,
  handleAuthCallback,
  checkLicense,
};
