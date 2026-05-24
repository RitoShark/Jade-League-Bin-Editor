//! Stage 2b: SDBM hash resolver + INI text writer.
//!
//! Direct port of `parser/hash_resolver.py`. Resolves the parsed
//! u32 hashes back to `section.name` pairs by SDBM-hashing every
//! candidate name from `dictionary` against every known section, then
//! emits a deterministic INI string the downstream stages consume.
//!
//! Output is intentionally byte-identical to the Python tool's
//! `write_ini` so we can diff stage-2 output during porting.

use std::collections::HashMap;

use super::binary::{TroybinEntry, TroybinValue};
use super::dictionary::{
    field_names, fluid_names, group_names, part_field_names, part_fluid_names,
    part_group_names, system_names,
};

/// SDBM-style hash used by Troybin / Inibin property naming. Port of
/// the Python `ihash`: walks the string in order, lowercasing each
/// byte (ASCII only) and accumulating `ret = (lower + ret*65599)` mod
/// 2^32. The optional initial `ret` lets us chain hashes (section into
/// name) without re-walking the section bytes.
pub fn ihash(value: &str, mut ret: u32) -> u32 {
    for ch in value.chars() {
        let lower = ch.to_ascii_lowercase() as u32;
        ret = lower.wrapping_add(ret.wrapping_mul(65599));
    }
    ret
}

/// One candidate dictionary entry — section + name combo plus the
/// resulting SDBM hash. The Python tool builds these eagerly into a
/// big vector and matches against the parsed entries; we do the same.
#[derive(Debug, Clone)]
struct DictEntry {
    section: String,
    name_entry: String,
    hash: u32,
}

/// `a_ihash` from the Python tool: for every (section × name)
/// combination, generate two variants — the bare `name` and the
/// quote-prefixed `'name`. Both are valid INI property names in the
/// Troybin tooling; the prefix encodes a "comment-out" form that
/// players sometimes leave in shipped files.
fn a_ihash(sections: &[String], names: &[String]) -> Vec<DictEntry> {
    let comments = ["", "'"];
    let mut out: Vec<DictEntry> = Vec::with_capacity(sections.len() * names.len() * comments.len());
    for section in sections {
        // Hash chain: section first, then literal "*" suffix, then the
        // name with optional `'` prefix. Matches `ihash("*", ihash(section))`
        // in the Python.
        let section_hash = ihash("*", ihash(section, 0));
        for name in names {
            for c in &comments {
                let name_entry = format!("{c}{name}");
                let hash = ihash(&name_entry, section_hash);
                out.push(DictEntry {
                    section: section.clone(),
                    name_entry,
                    hash,
                });
            }
        }
    }
    out
}

/// Pull every value out of `entries` whose hash matches any
/// `section × name` combination. Stringified — used to discover dynamic
/// section names (group ids, field ids) before building the rest of
/// the dictionary.
fn get_values(entries: &[TroybinEntry], sections: &[String], names: &[String]) -> Vec<String> {
    let h = a_ihash(sections, names);
    let mut hash_map: HashMap<u32, &TroybinValue> = HashMap::with_capacity(entries.len());
    for e in entries {
        hash_map.insert(e.hash, &e.value);
    }
    let mut out: Vec<String> = Vec::new();
    for item in h {
        if let Some(val) = hash_map.get(&item.hash) {
            out.push(value_to_string(val));
        }
    }
    out
}

/// Format a typed value as the plain text used internally by the
/// Python tool's `get_values` (Section name discovery). Numbers come
/// out without quoting, vectors space-joined, strings verbatim.
fn value_to_string(v: &TroybinValue) -> String {
    match v {
        TroybinValue::Number(n) => format_number_for_get_values(*n),
        TroybinValue::Int(i) => i.to_string(),
        TroybinValue::Vec(xs) => xs
            .iter()
            .map(|x| format_number_for_get_values(*x))
            .collect::<Vec<_>>()
            .join(" "),
        TroybinValue::Str(s) => s.clone(),
        TroybinValue::Bool(b) => b.to_string(),
        TroybinValue::NaN => "nan".to_string(),
    }
}

/// The Python tool's `str(int_or_float)` for numeric values. Ints come
/// out without a decimal (Python's `int.__str__`), floats use Python's
/// shortest-round-trip repr. Our `TroybinValue::Number` is always f64
/// (Python's `float(data)` cast applies even to int-shaped strings),
/// so we approximate Python's str(float) here.
fn format_number_for_get_values(n: f64) -> String {
    if n.is_nan() { return "nan".to_string(); }
    if n.is_infinite() { return if n.is_sign_negative() { "-inf".into() } else { "inf".into() }; }
    python_str_float(n)
}

/// Approximate Python's `str(float)` output. Python uses the shortest
/// round-trip representation; Rust's default `Display` for f64 omits
/// the trailing `.0` for whole numbers. We append it back to match
/// Python's `1.0` / `2.5` formatting.
pub(crate) fn python_str_float(n: f64) -> String {
    if n == 0.0 {
        // Match Python's "0.0" / "-0.0".
        return if n.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    let s = format!("{}", n);
    // Rust f64::Display prints "1" for 1.0, "1.5" for 1.5, "1e30" for
    // very large. Python prints "1.0", "1.5", "1e+30". We need the
    // trailing ".0" for integer-valued floats but leave scientific
    // notation alone (small cosmetic divergence is OK for INI text
    // unless the user reports a mismatch).
    if s.contains('.') || s.contains('e') || s.contains('E') {
        s
    } else {
        format!("{s}.0")
    }
}

/// One resolved (section, name, value) triple grouped by section, with
/// `unknown_hashes` carrying anything we couldn't resolve.
#[derive(Debug)]
struct ResolvedGroup {
    group_name: String,
    properties: Vec<ResolvedProperty>,
}

#[derive(Debug)]
struct ResolvedProperty {
    property_name: String,
    value: TroybinValue,
}

#[derive(Debug)]
struct ResolvedResult {
    values: Vec<ResolvedGroup>,
    unknown_hashes: Vec<TroybinEntry>,
}

/// Build the full resolution dictionary by:
/// 1. Hashing every (`System` × every group-discovery name) combination
///    to find the group ids declared in this troybin.
/// 2. Same trick for field and fluid ids — sections nested inside the
///    discovered groups.
/// 3. Then combining (groups × group-property names),
///    (fields × field-property names), (fluids × fluid-property names),
///    and (`System` × system-property names) into the full dictionary.
fn get_fixdict(entries: &[TroybinEntry]) -> Vec<DictEntry> {
    let groups = get_values(entries, &["System".to_string()], &part_group_names());
    let fields = get_values(entries, &groups, &part_field_names());
    let fluids = get_values(entries, &groups, &part_fluid_names());

    let dict_layers: [(Vec<String>, Vec<String>); 4] = [
        (groups, group_names()),
        (fields, field_names()),
        (fluids, fluid_names()),
        (vec!["System".to_string()], system_names()),
    ];

    let mut out: Vec<DictEntry> = Vec::new();
    for (sections, names) in &dict_layers {
        out.extend(a_ihash(sections, names));
    }
    out
}

/// Walk every dictionary candidate, match against the parsed entries,
/// and group resolved properties under their section. Anything left
/// over is reported as `unknown_hashes` for the `[UNKNOWN_HASHES]`
/// section of the INI output.
fn fix(entries: &[TroybinEntry]) -> ResolvedResult {
    let fixd = get_fixdict(entries);

    let mut entry_by_hash: HashMap<u32, &TroybinEntry> = HashMap::with_capacity(entries.len());
    for e in entries {
        // First-write-wins matches the Python `for e in entries: if e["hash"] == fd["ret"]: break`
        // which finds the first matching entry. With our HashMap we'd
        // get the last write, so use entry() to keep the first.
        entry_by_hash.entry(e.hash).or_insert(e);
    }

    let mut values: Vec<ResolvedGroup> = Vec::new();
    let mut group_index_by_name: HashMap<String, usize> = HashMap::new();
    let mut values_found: std::collections::HashSet<u32> = std::collections::HashSet::new();

    for fd in &fixd {
        if values_found.contains(&fd.hash) { continue; }
        let Some(matching) = entry_by_hash.get(&fd.hash) else { continue; };
        let prop = ResolvedProperty {
            property_name: fd.name_entry.clone(),
            value: (*matching).value.clone(),
        };
        if let Some(&idx) = group_index_by_name.get(&fd.section) {
            values[idx].properties.push(prop);
        } else {
            let idx = values.len();
            group_index_by_name.insert(fd.section.clone(), idx);
            values.push(ResolvedGroup {
                group_name: fd.section.clone(),
                properties: vec![prop],
            });
        }
        values_found.insert(fd.hash);
    }

    let unknown_hashes: Vec<TroybinEntry> = entries
        .iter()
        .filter(|e| !values_found.contains(&e.hash))
        .cloned()
        .collect();

    ResolvedResult { values, unknown_hashes }
}

// ── INI writer ─────────────────────────────────────────────────────

/// Natural-sort key — split `s` into runs of digits / non-digits, with
/// digit runs compared numerically and string runs case-insensitively.
/// Used to order both group headers and property lines in the INI
/// output deterministically, matching the Python tool.
fn natsort_key(s: &str) -> Vec<NatPart> {
    let mut out: Vec<NatPart> = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() { i += 1; }
            let num: u64 = s[start..i].parse().unwrap_or(0);
            out.push(NatPart::Num(num));
        } else {
            let start = i;
            while i < bytes.len() && !bytes[i].is_ascii_digit() { i += 1; }
            out.push(NatPart::Text(s[start..i].to_ascii_lowercase()));
        }
    }
    out
}

#[derive(Clone, Eq, PartialEq)]
enum NatPart {
    Num(u64),
    Text(String),
}

impl Ord for NatPart {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering::*;
        match (self, other) {
            (NatPart::Num(a), NatPart::Num(b)) => a.cmp(b),
            (NatPart::Text(a), NatPart::Text(b)) => a.cmp(b),
            // Mixed types — Python's natural sort compares heterogeneous
            // chunks by stringifying. Mirror that loosely: numbers
            // sort before text.
            (NatPart::Num(_), NatPart::Text(_)) => Less,
            (NatPart::Text(_), NatPart::Num(_)) => Greater,
        }
    }
}

impl PartialOrd for NatPart {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Render a single property line. String values get quoted UNLESS they
/// happen to parse as a float (mirrors the Python `try: float(value)`
/// fast-path). Numeric / vec / bool values render unquoted.
fn write_value_line(name: &str, value: &TroybinValue, out: &mut String) {
    out.push_str(name);
    out.push('=');
    match value {
        TroybinValue::Number(n) => out.push_str(&python_str_float(*n)),
        TroybinValue::Int(i) => out.push_str(&i.to_string()),
        TroybinValue::Vec(xs) => {
            let joined = xs
                .iter()
                .map(|x| python_str_float(*x))
                .collect::<Vec<_>>()
                .join(" ");
            out.push_str(&joined);
        }
        TroybinValue::Str(s) => {
            // Python `try: float(value)` — if the string parses as a
            // float, output it un-quoted (matches the tool's quirky
            // emit behavior even though it's strictly speaking lossy
            // INI). Otherwise wrap in double-quotes.
            if s.parse::<f64>().is_ok() {
                out.push_str(s);
            } else {
                out.push('"');
                out.push_str(s);
                out.push('"');
            }
        }
        TroybinValue::Bool(b) => {
            // Python `isinstance(value, bool)` would render `True/False`,
            // BUT the Python tool's flow stores bools as int (0/1) via
            // `sanitize_str` + the bool reader, so the int branch fires.
            // Mirror that: print as integer.
            out.push_str(&b.to_string());
        }
        TroybinValue::NaN => out.push_str("nan"),
    }
    out.push_str("\r\n");
}

/// Render the full resolved tree as INI text — group headers, sorted
/// property lines, blank-line separators, and a trailing
/// `[UNKNOWN_HASHES]` block if anything couldn't be resolved.
fn write_ini(r: &ResolvedResult) -> String {
    let mut out = String::new();

    let mut groups: Vec<&ResolvedGroup> = r.values.iter().collect();
    groups.sort_by(|a, b| natsort_key(&a.group_name).cmp(&natsort_key(&b.group_name)));

    for group in groups {
        out.push('[');
        out.push_str(&group.group_name);
        out.push(']');
        out.push_str("\r\n");

        let mut props: Vec<&ResolvedProperty> = group.properties.iter().collect();
        props.sort_by(|a, b| natsort_key(&a.property_name).cmp(&natsort_key(&b.property_name)));
        for prop in props {
            write_value_line(&prop.property_name, &prop.value, &mut out);
        }
        out.push_str("\r\n");
    }

    if !r.unknown_hashes.is_empty() {
        out.push_str("[UNKNOWN_HASHES]");
        out.push_str("\r\n");
        for unk in &r.unknown_hashes {
            // Hash printed as a bare integer to match the Python tool
            // (which uses `str(int)`).
            write_value_line(&unk.hash.to_string(), &unk.value, &mut out);
        }
    }

    out
}

/// Public entry point — equivalent to the Python tool's
/// `resolve_and_write_ini(entries)`.
pub fn resolve_and_write_ini(entries: &[TroybinEntry]) -> String {
    let resolved = fix(entries);
    write_ini(&resolved)
}
