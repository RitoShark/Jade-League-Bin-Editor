//! Object-centric read/write views over the Jade-native `Bin`.
//!
//! The Jade tree is section-based (`sections["entries"]` is a
//! `Map<Hash, Embed>`), but the walkers want an object-map view like the
//! LTK tree exposes. These helpers bridge that gap so the
//! texture/animation/mesh/repath walkers can iterate objects and look up
//! fields by FNV1a hash without re-deriving the section layout.

use super::types::{Bin, BinField, BinValue};

/// Borrowed view of one object entry.
pub struct ObjectRef<'a> {
    pub path_hash: u32,
    pub class_hash: u32,
    pub fields: &'a [BinField],
}

/// Iterate every object in the bin's `entries` section.
pub fn objects(bin: &Bin) -> Vec<ObjectRef<'_>> {
    let mut out = Vec::new();
    if let Some(BinValue::Map { items, .. }) = bin.sections.get("entries") {
        for (key, val) in items {
            let path_hash = match key {
                BinValue::Hash(h) => h.hash,
                _ => continue,
            };
            if let BinValue::Embed { name, fields } | BinValue::Pointer { name, fields } = val {
                out.push(ObjectRef { path_hash, class_hash: name.hash, fields });
            }
        }
    }
    out
}

/// Look up a single object by its path hash.
pub fn object(bin: &Bin, path_hash: u32) -> Option<ObjectRef<'_>> {
    if let Some(BinValue::Map { items, .. }) = bin.sections.get("entries") {
        for (key, val) in items {
            let BinValue::Hash(h) = key else { continue };
            if h.hash != path_hash {
                continue;
            }
            if let BinValue::Embed { name, fields } | BinValue::Pointer { name, fields } = val {
                return Some(ObjectRef { path_hash, class_hash: name.hash, fields });
            }
        }
    }
    None
}

/// Field lookup by FNV1a hash within a Pointer/Embed field list.
pub fn field<'a>(fields: &'a [BinField], hash: u32) -> Option<&'a BinValue> {
    fields.iter().find(|f| f.key.hash == hash).map(|f| &f.value)
}

/// The `linked:` dependency strings (other bins this file references).
pub fn dependencies(bin: &Bin) -> Vec<&str> {
    match bin.sections.get("linked") {
        Some(BinValue::List { items, .. }) => items
            .iter()
            .filter_map(|v| match v {
                BinValue::String(s) => Some(s.as_str()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Read access to the raw `entries` map pairs (key = path-hash, value =
/// object Embed). Used by the merge path to copy objects between trees.
pub fn entries(bin: &Bin) -> &[(BinValue, BinValue)] {
    match bin.sections.get("entries") {
        Some(BinValue::Map { items, .. }) => items,
        _ => &[],
    }
}

/// Mutable access to the raw `entries` map pairs — used by repath to
/// walk and rewrite string leaves in place.
pub fn entries_mut(bin: &mut Bin) -> Option<&mut Vec<(BinValue, BinValue)>> {
    match bin.sections.get_mut("entries") {
        Some(BinValue::Map { items, .. }) => Some(items),
        _ => None,
    }
}

/// Mutable access to the `linked:` dependency list values.
pub fn dependencies_mut(bin: &mut Bin) -> Option<&mut Vec<BinValue>> {
    match bin.sections.get_mut("linked") {
        Some(BinValue::List { items, .. }) => Some(items),
        _ => None,
    }
}
