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

## Phase 1 — Web (Vercel)

**Host = Vercel.** The project lives in this GitHub repo (so you can `git pull` it on both
your Mac and Windows PC for the desktop builds). Vercel connects to that repo and
auto-redeploys on every `git push` — the same workflow you already use for
`killaviccheatcodes.app`, and it makes it easy to put BAETHOVEN under that domain.

### First-time setup

1. **Push the repo to GitHub** (one Git repo for all three phases):
   ```bash
   gh auth login          # one-time: GitHub.com → HTTPS → Login with a web browser
   gh repo create baethoven --public --source=. --remote=origin --push
   ```
2. **Import it into Vercel** → <https://vercel.com/new> → "Import" the `baethoven` repo →
   in the project settings set:
   - **Framework Preset:** Other
   - **Root Directory:** `web`   ← important; this serves `web/index.html`
   - **Build Command:** *(leave empty)*  •  **Output Directory:** *(leave empty)*

   Click **Deploy**. The app goes live at `https://baethoven-<hash>.vercel.app` (and a
   stable `https://baethoven.vercel.app`-style project URL).

### Updating the live site

```bash
git add . && git commit -m "update" && git push   # Vercel redeploys automatically
```

### Custom domain (optional)

In the Vercel project → **Settings → Domains**, add e.g. `baethoven.killaviccheatcodes.app`
(a subdomain of your existing Vercel-managed domain — just add it, no DNS juggling needed
since the apex is already on Vercel).

### Alternative hosts (if you ever switch)

- **GitHub Pages** — free, serves from this same repo. Set Pages source to a static deploy
  of `web/` (a small Actions workflow, or move `index.html` to `/docs`). Lives at
  `thewoodendeer.github.io/baethoven`.
- **Cloudflare Pages / Netlify** — connect the repo, **build command = (none)**,
  **output/publish directory = `web`**.

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
