use std::fs;
use std::path::Path;

fn main() {
    // The auth window loads `WebviewUrl::App("auth.html")`, which resolves inside the
    // frontendDist (`../web`). `src-tauri/auth.html` is the canonical source, so keep the
    // served copy in sync on every build.
    let src = Path::new("auth.html");
    let dest = Path::new("../web/auth.html");
    if src.exists() {
        let _ = fs::copy(src, dest);
    }
    println!("cargo:rerun-if-changed=auth.html");

    tauri_build::build();
}
