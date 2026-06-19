# BAETHOVEN — MPC Sample Pad Builder

A finished, fully self-contained web app (a 4×4 MPC-style sample-pad / chord builder).
All UI is CSS/DOM + inline SVG; **all sound is Web Audio** — **zero external dependencies**
(no CDN, no npm runtime deps, no backend, no API, no image assets).

This repo ships **one HTML file unchanged** to three targets:

1. **Web** — static site (GitHub Pages).
2. **macOS** — universal `.app`/`.dmg` via Tauri (built locally on a Mac).
3. **Windows** — `.msi`/`.exe` via Tauri (built locally on a Windows PC).

> ⚠️ **Ship-as-is rule.** `web/index.html` is the canonical, bundled artifact and must
> stay **byte-for-byte identical** to the original `baethoven_app.html`. Never hand-edit it.
> To change the design, edit the files in [`source/`](source/) and re-inline (see below).

---

## Repo layout

```
baethoven/
├── web/
│   └── index.html          # THE shipped artifact (= baethoven_app.html, unchanged)
├── desktop/                # Tauri wrapper (created in Phase 2; loads ../web/index.html)
├── source/                 # editable design source (DO NOT ship directly)
│   ├── BAETHOVEN.dc.html   #   authored "Design Component" (HTML template + logic)
│   └── support.js          #   tiny runtime that renders the Design Component
├── .github/workflows/
│   └── pages.yml           # static deploy of web/ to GitHub Pages
├── .gitignore
└── README.md
```

`web/index.html` is the **output** of inlining `source/` — it is what every target loads.

---

## Run it locally

It's a single static file. Any of these work:

```bash
# Just open it (Web Audio works on file:// too):
open web/index.html                 # macOS
start web\index.html                # Windows

# Or serve it like production (recommended, mirrors hosting):
cd web && python3 -m http.server 8080
# then visit http://localhost:8080
```

> Sound requires a **user gesture** (Web Audio policy): click/tap a pad to start audio.

---

## Phase 1 — Web (GitHub Pages)

**Why GitHub Pages:** the project already lives in this Git repo (so you can `git pull` on
both your Mac and Windows PC), and Pages serves straight from that same repo — no extra
service or account, free, and a `git push` to `main` redeploys automatically via
[`.github/workflows/pages.yml`](.github/workflows/pages.yml). (Cloudflare Pages / Vercel /
Netlify also work — see "Alternative hosts" below.)

### First-time setup

1. Create the GitHub repo and push:
   ```bash
   gh repo create baethoven --public --source=. --remote=origin --push
   # or, without gh:
   git remote add origin https://github.com/thewoodendeer/baethoven.git
   git push -u origin main
   ```
2. In the repo on github.com → **Settings → Pages → Build and deployment → Source =
   "GitHub Actions"**. (One-time. The included workflow does the rest.)
3. Push to `main` (or run the workflow manually under the **Actions** tab). When it
   finishes, your site is live at:
   ```
   https://thewoodendeer.github.io/baethoven/
   ```

### Updating the live site

```bash
git add . && git commit -m "update" && git push   # Pages redeploys automatically
```

### Custom domain (optional)

The apex `killaviccheatcodes.app` is on Vercel, but you can point a **subdomain** at Pages
(e.g. `baethoven.killaviccheatcodes.app`): add a `CNAME` DNS record →
`thewoodendeer.github.io`, then set it under Settings → Pages → Custom domain. A
`web/CNAME` file holding the domain keeps it sticky across deploys.

### Alternative hosts

- **Cloudflare Pages / Netlify / Vercel** — connect this GitHub repo, set the
  **build command = (none)** and the **output/publish directory = `web`**. One static file,
  no build. Vercel is handy if you want it under the existing `killaviccheatcodes.app` domain
  (that domain is already on your Vercel account).

---

## Phase 2 — macOS desktop build (Tauri)  _(set up on the Mac)_

> Filled in during Phase 2. Summary of the intended flow:

- `desktop/` is a Tauri **vanilla** project whose frontend is the unchanged `web/index.html`.
- Build a universal (arm64 + x64) binary:
  ```bash
  cd desktop
  npm install
  npm run tauri build -- --target universal-apple-darwin
  ```
- Output: `desktop/src-tauri/target/universal-apple-darwin/release/bundle/{macos,dmg}/`.
- Web Audio works in the macOS WKWebView with no extra permissions.
- Code-signing / notarization notes for distribution outside the App Store: see Phase 2.

## Phase 3 — Windows desktop build (Tauri)  _(set up on the Windows PC)_

> Filled in during Phase 3. Summary of the intended flow:

- `git pull` this repo on the Windows PC (same `desktop/` Tauri project).
- ```powershell
  cd desktop
  npm install
  npm run tauri build
  ```
- Output: `desktop/src-tauri/target/release/bundle/{msi,nsis}/`.
- Authenticode code-signing notes (to avoid SmartScreen warnings): see Phase 3.

---

## Editing the design later (keeping it identical)

Edit `source/BAETHOVEN.dc.html` (+ `source/support.js`), then **re-inline** them back into a
single file and overwrite `web/index.html`. Any HTML inliner that folds `<script src>` /
`<link>` references into the document produces the bundled file. Always verify the result
still opens and plays offline before committing.
