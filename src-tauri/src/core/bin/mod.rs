// Bin module exports
pub mod ltk_bridge;
pub mod converter;
pub mod jade;

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

// Re-export ltk_meta types directly (allow unused for external usage)
#[allow(unused_imports)]
pub use ltk_meta::{BinTree, BinTreeObject, BinProperty, BinPropertyKind, PropertyValueEnum};

