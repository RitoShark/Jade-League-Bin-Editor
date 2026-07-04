// Bin module exports
pub mod ltk_bridge;
pub mod converter;
pub mod jade;
pub mod adapt;
pub mod engine;
pub mod repath;
pub mod asset_scan;

// Engine-aware entry points + the canonical Jade tree types. These are
// what the texture/animation/mesh/repath walkers use so they stay
// agnostic to which converter engine parsed the bytes.
#[allow(unused_imports)]
pub use engine::{read_bin_engine, write_bin_engine, use_jade_engine};
#[allow(unused_imports)]
pub use jade::types::{Bin as JadeBin, BinValue, BinType, BinField, FNV1a, XXH64};

// Re-export ltk-based functions from bridge
#[allow(unused_imports)]
pub use ltk_bridge::{
    read_bin as read_bin_ltk,
    write_bin as write_bin_ltk,
    tree_to_text,
    tree_to_text_with_resolved_names,
    tree_to_text_cached,
    get_cached_bin_hashes,
    reload_cached_bin_hashes,
    are_hashes_loaded,
    estimate_ltk_hash_memory,
    text_to_tree,
    HashMapProvider,
    MAX_BIN_SIZE,
};

// Re-export ltk_meta types directly (allow unused for external usage).
// ltk_meta 0.5 renamed `BinTree`/`BinTreeObject`/`BinPropertyKind` and
// dropped the `BinProperty` wrapper (object properties are now a plain
// `IndexMap<u32, PropertyValueEnum>`). Alias the names the codebase uses.
#[allow(unused_imports)]
pub use ltk_meta::{
    Bin as BinTree,
    BinObject as BinTreeObject,
    PropertyKind as BinPropertyKind,
    PropertyValueEnum,
};

