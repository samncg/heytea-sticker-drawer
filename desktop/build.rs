// Copies the shared engine (../engine.js, ../worker.js) into the app's UI at build time, so the app plans
// drawings with exactly the same code as the web page and the command line.
use std::{fs, path::Path};

fn main() {
    let vendor = Path::new("ui/vendor");
    fs::create_dir_all(vendor).expect("create ui/vendor");
    for name in ["engine.js", "worker.js"] {
        let from = Path::new("..").join(name);
        println!("cargo:rerun-if-changed={}", from.display());
        fs::copy(&from, vendor.join(name)).unwrap_or_else(|e| panic!("copy {}: {e}", from.display()));
    }
    tauri_build::build()
}
