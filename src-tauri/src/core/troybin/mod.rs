//! Troybin / Inibin → ritobin BIN converter.
//!
//! Port of the Python `troybin2bin` tool — see
//! `other apps/troybin2bin-main/` for the reference implementation and
//! its 59-file test corpus. The corpus is **not** committed to this
//! repo; comparison is done manually against the Python tool's output
//! when debugging a regression.
//!
//! Pipeline (matches the Python tool 1:1):
//!
//! 1. [`binary`] — parse `.troybin` bytes into hash→value entries.
//!    Two on-disk versions exist (v1 "old" and v2 "new"); the version
//!    byte at offset 0 selects which reader runs.
//! 2. [`dictionary`] + [`ini`] — resolve u32 hashes to property
//!    names (SDBM-style hash), group by section, emit INI text. INI
//!    is an intermediate format kept verbatim for parity with the
//!    Python tool's `write_ini` so we can diff stage-2 output when
//!    debugging.
//!
//! Stages 3-5 (INI → ritobin text) live in sibling modules added in
//! later turns.

pub mod binary;
pub mod dictionary;
pub mod ini;
pub mod values;
pub mod format_value;
pub mod read_troybin;
pub mod update_emitters;
pub mod create_bin;
pub mod write_bin;

// Re-export the entry point + the types so future stages and the Tauri
// command layer can consume them without reaching into submodules.
#[allow(unused_imports)]
pub use binary::{read_troybin_binary, TroybinEntry, TroybinValue};
pub use ini::resolve_and_write_ini;
#[allow(unused_imports)]
pub use read_troybin::{read_troybin, TroybinData};
#[allow(unused_imports)]
pub use update_emitters::update_emitters;
#[allow(unused_imports)]
pub use create_bin::{create_bin, BinData};
#[allow(unused_imports)]
pub use write_bin::write_bin;
