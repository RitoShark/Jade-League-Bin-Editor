//! Engine-aware bin read/write entry points.
//!
//! The whole app walks the canonical Jade-native tree
//! ([`crate::core::bin::jade::types::Bin`]). These two functions are the
//! single choke points that honor the user's "Converter Engine" setting:
//!
//! - **Jade Custom** (default): parse/serialize with Jade's own
//!   reader/writer. No `ltk_meta` is involved at all.
//! - **LTK Converter**: parse/serialize with `ltk_meta`, then bridge to
//!   the Jade tree via [`super::adapt`] so the walkers are engine-agnostic.

use std::path::PathBuf;

use super::adapt;
use super::jade::{self, types::Bin as JadeBin};
use super::{read_bin_ltk, write_bin_ltk};

/// True when the "Jade Custom" converter engine is selected (the
/// default). Reads the same `preferences.json` the settings UI writes.
pub fn use_jade_engine() -> bool {
    let pref_file = match std::env::var("APPDATA") {
        Ok(appdata) => PathBuf::from(appdata)
            .join("LeagueToolkit")
            .join("Jade")
            .join("preferences.json"),
        Err(_) => return true, // default to Jade Custom
    };

    if let Ok(content) = std::fs::read_to_string(&pref_file) {
        if let Ok(prefs) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(engine) = prefs.get("ConverterEngine").and_then(|v| v.as_str()) {
                return engine == "jade";
            }
        }
    }
    true // default to Jade Custom
}

/// Parse raw bin bytes into the canonical Jade tree using the selected
/// engine. Field/key names are left hashed — the walkers match by FNV1a
/// hash, so name resolution would be wasted work here.
pub fn read_bin_engine(data: &[u8]) -> Result<JadeBin, String> {
    if use_jade_engine() {
        jade::reader::read(data).map_err(|e| format!("Jade reader error: {}", e.0))
    } else {
        let ltk = read_bin_ltk(data).map_err(|e| format!("LTK parse error: {e}"))?;
        Ok(adapt::ltk_to_jade(&ltk))
    }
}

/// Compile ritobin text directly to bin bytes using the selected
/// engine. Used by the troybin compiler and anywhere else that goes
/// text → bin without needing the intermediate tree.
pub fn text_to_bin_engine(text: &str) -> Result<Vec<u8>, String> {
    if use_jade_engine() {
        jade::convert_text_to_bin(text)
    } else {
        let tree = super::ltk_bridge::text_to_tree(text)
            .map_err(|e| format!("LTK parse error: {e}"))?;
        write_bin_ltk(&tree).map_err(|e| format!("LTK write error: {e}"))
    }
}

/// Serialize the canonical Jade tree back to bin bytes using the
/// selected engine.
pub fn write_bin_engine(bin: &JadeBin) -> Result<Vec<u8>, String> {
    if use_jade_engine() {
        jade::writer::write(bin).map_err(|e| format!("Jade writer error: {}", e.0))
    } else {
        let ltk = adapt::jade_to_ltk(bin)?;
        write_bin_ltk(&ltk).map_err(|e| format!("LTK write error: {e}"))
    }
}
