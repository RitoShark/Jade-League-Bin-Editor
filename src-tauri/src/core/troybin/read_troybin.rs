//! Stage 3: Maps INI properties to ritobin property definitions.
//!
//! Direct port of `converter/read_troybin.py`. Walks the INI text
//! produced by stages 1+2 section-by-section, looks each property up
//! in the appropriate namespace of [`values::values()`], formats the
//! raw value via [`format_value`], and gathers everything into
//! [`TroybinData`] for stages 4-5 to consume.

use serde::Serialize;

use super::format_value::{
    format_input, format_value, get_structure_data, FormattedValue,
};
use super::values::{values, BinGroup, DefaultValue, SvItem, ValueEntry};

// ── Public output types (`troybin_data` in the Python tool) ────────

#[derive(Debug, Clone, Serialize)]
pub struct TroybinData {
    pub file_name: String,
    pub emitters: Vec<Emitter>,
    pub system: Vec<Property>,
    /// Free-text bag of properties we couldn't resolve. Surfaced to
    /// the user as warnings; doesn't break the rest of the pipeline.
    pub unknown: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Emitter {
    pub name: String,
    pub properties: Vec<Property>,
    /// 1-based slot index (`GroupPartN` in the System block) — set
    /// when a system entry binds this emitter to a slot.
    pub order: i64,
    pub is_simple: bool,
    pub needs_changes: bool,
    pub is_multi_use_entry: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Property {
    pub troybin_name: String,
    pub troybin_type: String,
    pub bin_group: BinGroup,
    pub bin_group_type: String,
    pub bin_property_name: String,
    pub bin_property_type: String,
    // Order matches the Python tool's `fix_prop` so JSON diffs stay
    // line-for-line clean: `value` before `default_value`, optional
    // tails at the end.
    pub value: FormattedValueSerde,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<DefaultValueSerde>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub simple_value: Vec<SvItemSerde>,
    /// Set when the property was a MaterialOverride or a `f-...`
    /// definition-id field — the suffix the parser stripped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition_id: Option<DefinitionId>,
}

/// `definition_id` can be a bare boolean flag (`f-…` apostrophed
/// variant: set to `true`) or a string slug (MaterialOverride suffix).
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum DefinitionId {
    Bool(bool),
    Str(String),
}

// Serialisation wrappers — the `Value` types we keep internally as
// enums don't have implicit serde representations because their JSON
// shape needs to match the Python tool's output for diffing.

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum DefaultValueSerde {
    Int(i64),
    Str(String),
}

impl From<DefaultValue> for DefaultValueSerde {
    fn from(v: DefaultValue) -> Self {
        match v {
            DefaultValue::Int(i) => DefaultValueSerde::Int(i),
            DefaultValue::Str(s) => DefaultValueSerde::Str(s),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum SvItemSerde {
    Text(String),
    Group(BinGroup),
}

impl From<SvItem> for SvItemSerde {
    fn from(v: SvItem) -> Self {
        match v {
            SvItem::Text(s) => SvItemSerde::Text(s),
            SvItem::Group(g) => SvItemSerde::Group(g),
        }
    }
}

/// Serde shim around [`FormattedValue`] that mirrors the Python tool's
/// untagged dict output — numbers, lists of numbers, strings, lists of
/// strings, bools, ints, and the axis pair all render as their natural
/// JSON shapes. `Invalid` becomes JSON null.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum FormattedValueSerde {
    // Order matters: serde's untagged enum tries variants in order
    // and picks the first that fits. Put `Int` before `Number` so a
    // whole f64 still serialises as f64 (only explicit i64 values
    // land in Int), and `IntList` before `Numbers` for the same
    // reason at the list level.
    Int(i64),
    Number(f64),
    IntList(Vec<i64>),
    Numbers(Vec<f64>),
    Bool(bool),
    Str(String),
    Strings(Vec<String>),
    /// `[axis_label, value]` to match Python's `[axis, val]` shape.
    AxisValue([serde_json::Value; 2]),
    Null,
}

impl From<FormattedValue> for FormattedValueSerde {
    fn from(v: FormattedValue) -> Self {
        match v {
            FormattedValue::Number(n) => FormattedValueSerde::Number(n),
            FormattedValue::Numbers(ns) => FormattedValueSerde::Numbers(ns),
            FormattedValue::Int(i) => FormattedValueSerde::Int(i),
            FormattedValue::IntList(is) => FormattedValueSerde::IntList(is),
            FormattedValue::Bool(b) => FormattedValueSerde::Bool(b),
            FormattedValue::Str(s) => FormattedValueSerde::Str(s),
            FormattedValue::Strings(ss) => FormattedValueSerde::Strings(ss),
            FormattedValue::AxisValue(axis, val) => FormattedValueSerde::AxisValue([
                serde_json::Value::String(axis),
                serde_json::Value::from(val),
            ]),
            FormattedValue::Invalid => FormattedValueSerde::Null,
        }
    }
}

// ── Natural sort key for property names (same as ini.rs but local) ─

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
enum NatPart { Num(u64), Text(String) }
impl Ord for NatPart {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering::*;
        match (self, other) {
            (NatPart::Num(a), NatPart::Num(b)) => a.cmp(b),
            (NatPart::Text(a), NatPart::Text(b)) => a.cmp(b),
            (NatPart::Num(_), NatPart::Text(_)) => Less,
            (NatPart::Text(_), NatPart::Num(_)) => Greater,
        }
    }
}
impl PartialOrd for NatPart {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> { Some(self.cmp(other)) }
}

// ── Internal raw-section model ─────────────────────────────────────

struct RawSection {
    name: String,
    /// Sorted property strings (`name=value`) for the section.
    properties: Vec<String>,
    /// True if this is the synthetic `[UNKNOWN_HASHES]` block.
    is_unknown_section: bool,
}

// ── Main entry point ───────────────────────────────────────────────

/// Stage 3 — port of `read_troybin` in `converter/read_troybin.py`.
///
/// * `default_assets_path` — passed through to `format_value` for
///   `STRING_PATH` prefixing. Reference uses `"Assets/Particles"`.
/// * `names_only` — when true, unknown-property reports list only the
///   property name (terser).
/// * `original_troybin` — the INI text from stage 2.
/// * `output_filename` — the original filename stem the caller wants
///   stamped onto the output; trailing `.txt` is stripped.
/// * `update_file_types` — `.tga → .dds` rewrite in `STRING_PATH`
///   values.
pub fn read_troybin(
    default_assets_path: &str,
    names_only: bool,
    original_troybin: &str,
    output_filename: &str,
    update_file_types: bool,
) -> TroybinData {
    let vals = values();

    let troybin_array = format_input(original_troybin);
    let struct_data = get_structure_data(&troybin_array);

    // Build per-section RawSection blobs first, keeping system and the
    // unknown block separate so we can re-order them last.
    let mut system: Option<RawSection> = None;
    let mut unknown: Option<RawSection> = None;
    let mut troybin_entries: Vec<RawSection> = Vec::new();

    let indices = &struct_data.entry_start_indices;

    for i in 0..struct_data.entry_amount {
        let is_unknown = struct_data.unknown_index != -1
            && struct_data.unknown_index == indices[i] as i64;
        let start = indices[i];
        let end = if i + 1 < indices.len() {
            indices[i + 1]
        } else {
            troybin_array.len()
        };

        let entry_name = if is_unknown {
            "UNKNOWN_HASHES".to_string()
        } else {
            troybin_array[start]
                .replace('[', "")
                .replace(']', "")
                .replace('\'', "")
        };

        // Skip the header for non-unknown sections.
        let props_start = if is_unknown { start } else { start + 1 };
        let mut props: Vec<String> = troybin_array[props_start..end].to_vec();
        props.sort_by(|a, b| {
            let na = a.split('=').next().unwrap_or("").replace('\'', "");
            let nb = b.split('=').next().unwrap_or("").replace('\'', "");
            natsort_key(&na).cmp(&natsort_key(&nb))
        });

        let section = RawSection { name: entry_name.clone(), properties: props, is_unknown_section: is_unknown };
        match entry_name.as_str() {
            "System" => system = Some(section),
            "UNKNOWN_HASHES" => unknown = Some(section),
            _ => troybin_entries.push(section),
        }
    }

    // Push unknown after the emitter sections (only if it has props),
    // then system last — order is preserved from the Python reference
    // so the GroupPart bindings find emitters already present in
    // `troybin_data.emitters`.
    if let Some(unk) = &unknown {
        if !unk.properties.is_empty() {
            troybin_entries.push(unknown.take().unwrap());
        }
    }
    if let Some(sys) = system.take() {
        troybin_entries.push(sys);
    }

    let mut data = TroybinData {
        file_name: output_filename.trim_end_matches(".txt").to_string(),
        emitters: Vec::new(),
        system: Vec::new(),
        unknown: Vec::new(),
    };

    for entry in &troybin_entries {
        let is_system = entry.name == "System";
        let is_unknown_section = entry.is_unknown_section;

        let mut emitter = Emitter {
            name: entry.name.clone(),
            properties: Vec::new(),
            order: 0,
            is_simple: false,
            needs_changes: false,
            is_multi_use_entry: Vec::new(),
        };

        for prop_str in &entry.properties {
            process_property(
                vals,
                default_assets_path,
                update_file_types,
                names_only,
                &entry.name,
                is_system,
                is_unknown_section,
                prop_str,
                &mut emitter,
                &mut data,
            );
        }

        if !is_system {
            data.emitters.push(emitter);
        }
    }

    data
}

#[allow(clippy::too_many_arguments)]
fn process_property(
    vals: &super::values::ValuesTable,
    default_assets_path: &str,
    update_file_types: bool,
    names_only: bool,
    entry_name: &str,
    is_system: bool,
    is_unknown_section: bool,
    prop_str: &str,
    emitter: &mut Emitter,
    data: &mut TroybinData,
) {
    let mut assigned: Option<ValueEntry> = None;
    let mut definition_id: Option<DefinitionId> = None;
    let mut emitter_name_index: i64 = -1;
    let mut entry_found = false;
    let mut needs_changes = false;

    let split = match prop_str.split_once('=') {
        Some(parts) => parts,
        None => return,
    };
    let property_name = split.0;
    let property_value_part = split.1;

    const FIELD_MARKERS: &[&str] = &[
        "field-accel-", "field-attract-", "field-drag-", "field-noise-", "field-orbit-",
    ];
    let is_disabled_field = FIELD_MARKERS.iter().any(|m| property_name.contains(m));

    // The Python tool gates the lookup with `not property_name or
    // property_name[0] != "'" or is_disabled_field`. Apostrophe-prefixed
    // names are normally skipped (they encode a "comment-out" form);
    // disabled-field markers force a lookup anyway because the reference
    // tool needs them to flag `needs_changes`.
    let pn_bytes = property_name.as_bytes();
    let do_lookup = !is_unknown_section
        && (pn_bytes.is_empty() || pn_bytes[0] != b'\'' || is_disabled_field);

    if do_lookup {
        if is_system {
            for sv in &vals.system_values {
                let tn = sv.troybin_name.as_str();
                if tn == "GroupPart" {
                    if property_name.contains("GroupPart")
                        && !property_name.contains("Importance")
                        && !property_name.contains("Type")
                    {
                        let suffix = property_name.replace("GroupPart", "");
                        let emitter_order_value: i64 = match suffix.parse() {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        assigned = Some(sv.clone());
                        entry_found = true;
                        let clean_val = property_value_part.replace('"', "");
                        emitter_name_index = data
                            .emitters
                            .iter()
                            .position(|e| e.name == clean_val)
                            .map(|i| i as i64)
                            .unwrap_or(-1);
                        if emitter_name_index != -1 {
                            let em = &mut data.emitters[emitter_name_index as usize];
                            if em.order != 0 {
                                em.is_multi_use_entry.push(emitter_order_value);
                            } else {
                                em.order = emitter_order_value;
                            }
                        }
                    }
                } else if tn == "GroupPartImportance" {
                    if property_name.contains("GroupPart") && property_name.contains("Importance") {
                        let stripped = property_name
                            .replace("GroupPart", "")
                            .replace("Importance", "");
                        let emitter_value: i64 = match stripped.parse() {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        assigned = Some(sv.clone());
                        entry_found = true;
                        emitter_name_index = data
                            .emitters
                            .iter()
                            .position(|e| e.order == emitter_value)
                            .map(|i| i as i64)
                            .unwrap_or(-1);
                    }
                } else if tn == "GroupPartType" {
                    if property_name.contains("GroupPart") && property_name.contains("Type") {
                        if property_value_part == "\"Simple\"" {
                            entry_found = true;
                            let stripped = property_name
                                .replace("GroupPart", "")
                                .replace("Type", "");
                            let emitter_value: i64 = match stripped.parse() {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            emitter_name_index = data
                                .emitters
                                .iter()
                                .position(|e| e.order == emitter_value)
                                .map(|i| i as i64)
                                .unwrap_or(-1);
                            if emitter_name_index != -1 {
                                let em = &mut data.emitters[emitter_name_index as usize];
                                em.needs_changes = true;
                                em.is_simple = true;
                            }
                        }
                    }
                } else if tn == property_name {
                    assigned = Some(sv.clone());
                    entry_found = true;
                }
            }
        } else if pn_bytes.first() == Some(&b'e') {
            for ev in &vals.e_values {
                if ev.troybin_name == property_name {
                    assigned = Some(ev.clone());
                    entry_found = true;
                    if property_name == "e-life" && property_value_part == "-1" {
                        needs_changes = true;
                    }
                    break;
                }
            }
        } else if pn_bytes.first() == Some(&b'f')
            || (pn_bytes.len() > 1 && pn_bytes[0] == b'\'' && pn_bytes[1] == b'f')
        {
            let check_name = if pn_bytes[0] == b'\'' {
                &property_name[1..]
            } else {
                property_name
            };
            for fv in &vals.f_values {
                if fv.troybin_name == property_name || fv.troybin_name == check_name {
                    assigned = Some(fv.clone());
                    entry_found = true;
                    if FIELD_MARKERS.iter().any(|m| property_name.contains(m)) {
                        needs_changes = true;
                    }
                    if pn_bytes[0] == b'\'' {
                        definition_id = Some(DefinitionId::Bool(true));
                    }
                    break;
                }
            }
            // Fallback: `flag-*` properties live in `p_values` but our
            // `f`-prefix prefix scan would have grabbed them.
            if !entry_found && property_name.starts_with("flag-") {
                for pv in &vals.p_values {
                    if pv.troybin_name == property_name {
                        assigned = Some(pv.clone());
                        entry_found = true;
                        break;
                    }
                }
            }
        } else if matches!(pn_bytes.first(), Some(b'p') | Some(b'P')) {
            for pv in &vals.p_values {
                if pv.troybin_name == property_name {
                    assigned = Some(pv.clone());
                    entry_found = true;
                    break;
                }
            }
        } else {
            for ov in &vals.others {
                if ov.troybin_name == property_name {
                    assigned = Some(ov.clone());
                    entry_found = true;
                    break;
                }
                if (ov.troybin_name == "MaterialOverrideTexture"
                    && property_name.contains("MaterialOverride")
                    && property_name.contains("Texture"))
                    || (ov.troybin_name == "MaterialOverridePriority"
                        && property_name.contains("MaterialOverride")
                        && property_name.contains("Priority"))
                {
                    let def_id = property_name
                        .replace("MaterialOverride", "")
                        .replace("Texture", "")
                        .replace("Priority", "");
                    assigned = Some(ov.clone());
                    definition_id = Some(DefinitionId::Str(def_id));
                    entry_found = true;
                    needs_changes = true;
                    break;
                }
            }
        }
    }

    // Complex-emitter type lines don't get an assignment but mustn't
    // be reported as unknown — match the case-insensitive `"complex"`
    // check the Python tool uses.
    let is_complex = property_name.contains("GroupPart")
        && property_name.contains("Type")
        && property_value_part.eq_ignore_ascii_case("\"complex\"");

    // Track unknowns (two slightly different conditions to mirror the
    // reference exactly).
    let assigned_has_group = assigned
        .as_ref()
        .map(|a| !a.bin_group.name.is_empty() || !a.bin_group.structure.is_empty())
        .unwrap_or(false);
    if !assigned_has_group && !needs_changes && !is_complex {
        push_unknown(data, names_only, entry_name, property_name, property_value_part);
    }
    if !entry_found && !is_complex {
        push_unknown(data, names_only, entry_name, property_name, property_value_part);
    }

    // Format the value & build the property object — only when we
    // have either a binding or `needs_changes` (field-inline cases).
    let assigned_ref = assigned.as_ref();
    let has_tn = assigned_ref.map(|a| !a.troybin_name.is_empty()).unwrap_or(false);
    if !has_tn && !needs_changes {
        return;
    }

    // Compute the formatted value with the same fallback chain as the
    // Python: primary `troybinType`, then any `simpleValue[0]` type
    // tag, then a fixed list of common shapes.
    let mut formatted = FormattedValue::Invalid;
    if has_tn {
        let a = assigned_ref.unwrap();
        formatted = format_value(property_value_part, &a.troybin_type, default_assets_path, update_file_types);

        if matches!(formatted, FormattedValue::Invalid) && !a.simple_value.is_empty() {
            let sv_type = match &a.simple_value[0] {
                SvItem::Text(s) => s.clone(),
                SvItem::Group(_) => String::new(),
            };
            if !sv_type.is_empty() {
                formatted = format_value(property_value_part, &sv_type, default_assets_path, update_file_types);
            }
        }
        if matches!(formatted, FormattedValue::Invalid) {
            for fallback in ["THREE_DOUBLE", "TWO_DOUBLE", "FOUR_DOUBLE", "ONE_DOUBLE", "STRING_NO_PATH"] {
                if fallback == a.troybin_type {
                    continue;
                }
                let f = format_value(property_value_part, fallback, default_assets_path, update_file_types);
                if !matches!(f, FormattedValue::Invalid) {
                    formatted = f;
                    break;
                }
            }
        }
    }

    if matches!(formatted, FormattedValue::Invalid) {
        // The reference appends a `(unexpected amount of values)`
        // suffix to the unknown-names list when names-only mode is on;
        // otherwise it logs the verbose `Section: name = value` form.
        let text = if names_only {
            format!("{property_name} (unexpected amount of values)")
        } else {
            format!("{entry_name}: {property_name} = {property_value_part}")
        };
        if !data.unknown.iter().any(|t| t == &text) {
            data.unknown.push(text);
        }
        return;
    }

    let prop = build_property(assigned_ref, formatted, definition_id);

    if is_system {
        if emitter_name_index != -1 {
            if needs_changes {
                let em = &mut data.emitters[emitter_name_index as usize];
                em.needs_changes = true;
                em.is_simple = true;
            } else {
                data.emitters[emitter_name_index as usize].properties.push(prop);
            }
        } else {
            data.system.push(prop);
        }
    } else {
        if needs_changes {
            emitter.needs_changes = true;
        }
        emitter.properties.push(prop);
    }
}

fn build_property(
    assigned: Option<&ValueEntry>,
    formatted: FormattedValue,
    definition_id: Option<DefinitionId>,
) -> Property {
    let default = assigned
        .and_then(|a| a.default_value.clone())
        .map(Into::into);
    let sv: Vec<SvItemSerde> = assigned
        .map(|a| a.simple_value.clone().into_iter().map(Into::into).collect())
        .unwrap_or_default();
    Property {
        troybin_name: assigned.map(|a| a.troybin_name.clone()).unwrap_or_default(),
        troybin_type: assigned.map(|a| a.troybin_type.clone()).unwrap_or_default(),
        bin_group: assigned.map(|a| a.bin_group.clone()).unwrap_or_default(),
        bin_group_type: assigned.map(|a| a.bin_group_type.clone()).unwrap_or_default(),
        bin_property_name: assigned.map(|a| a.bin_property_name.clone()).unwrap_or_default(),
        bin_property_type: assigned.map(|a| a.bin_property_type.clone()).unwrap_or_default(),
        default_value: default,
        simple_value: sv,
        value: formatted.into(),
        definition_id,
    }
}

fn push_unknown(
    data: &mut TroybinData,
    names_only: bool,
    entry_name: &str,
    property_name: &str,
    property_value_part: &str,
) {
    let text = if names_only {
        property_name.to_string()
    } else {
        format!("{entry_name}: {property_name} = {property_value_part}")
    };
    if !data.unknown.iter().any(|t| t == &text) {
        data.unknown.push(text);
    }
}

// Serde wrappers for BinGroup → JSON (needed because it lives in
// `values.rs` and we want a stable shape that matches the Python
// reference dump for diffing).
impl Serialize for BinGroup {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("BinGroup", 7)?;
        s.serialize_field("name", &self.name)?;
        s.serialize_field("structure", &self.structure)?;
        // `order` is f64 internally (some groups use fractional
        // ordering like `50.3`) but most are whole-valued. Emit
        // integer JSON when the value is a whole number so we don't
        // diverge from Python's `int` / `float` mixed output.
        if self.order.is_finite() && self.order == self.order.trunc() {
            s.serialize_field("order", &(self.order as i64))?;
        } else {
            s.serialize_field("order", &self.order)?;
        }
        s.serialize_field("propertyType", &self.property_type)?;
        s.serialize_field("hasMembers", &self.has_members)?;
        s.serialize_field("members", &self.members)?;
        if let Some(p) = &self.parent {
            s.serialize_field("parent", p)?;
        } else {
            s.skip_field("parent")?;
        }
        s.end()
    }
}
