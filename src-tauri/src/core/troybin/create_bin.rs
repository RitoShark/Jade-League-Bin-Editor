//! Stage 5a: groups emitter properties into the final bin structure.
//!
//! Direct port of `converter/create_bin.py`. Each emitter's flat list
//! of properties gets restructured into nested groups: walking each
//! property's `binGroup.parent` chain produces single-parent groupings
//! and parent-parent groupings (used by field definitions and material
//! overrides). The output is a JSON tree consumed by [`write_bin`].

use serde_json::{json, Value as JsonValue};

use super::read_troybin::{Property, TroybinData};

/// Property accessor helpers — work on a `Property` directly (because
/// it's stored as a typed Rust struct) rather than via `JsonValue`.

fn bg_name(p: &Property) -> &str {
    &p.bin_group.name
}

fn bg_order(p: &Property) -> f64 {
    p.bin_group.order
}

fn bg_members(p: &Property) -> &[String] {
    &p.bin_group.members
}

fn bg_parent_value(p: &Property) -> Option<&JsonValue> {
    p.bin_group.parent.as_ref()
}

/// Resolve a parent to its dict form. If parent is a list, returns the
/// first element. Matches Python's `_bg_parent_dict`.
fn parent_dict(parent: Option<&JsonValue>) -> Option<JsonValue> {
    match parent? {
        JsonValue::Object(_) => Some(parent?.clone()),
        JsonValue::Array(arr) if !arr.is_empty() => Some(arr[0].clone()),
        _ => None,
    }
}

/// Pull an attribute from a parent (handling list-of-dicts). Returns
/// `JsonValue::Null` when not found, mirroring Python's `.get(attr, default)`.
fn get_parent_attr(p: &Property, attr: &str) -> JsonValue {
    match bg_parent_value(p) {
        Some(JsonValue::Object(o)) => o.get(attr).cloned().unwrap_or(JsonValue::Null),
        Some(JsonValue::Array(arr)) => {
            for pp in arr {
                if let JsonValue::Object(o) = pp {
                    if let Some(v) = o.get(attr) {
                        if !v.is_null() {
                            return v.clone();
                        }
                    }
                }
            }
            JsonValue::Null
        }
        _ => JsonValue::Null,
    }
}

/// JSON-encode a `Property` so we can drop it into the output tree
/// without juggling two value families inside the same `members` list.
fn prop_to_json(p: &Property) -> JsonValue {
    serde_json::to_value(p).unwrap_or(JsonValue::Null)
}

// ── BinData shape (matches Python `bin_data` dict) ─────────────────

pub struct BinData {
    pub name: String,
    /// `complex` emitter list, each an ordered `Vec<group>`.
    pub complex_emitters: Vec<JsonValue>,
    /// `simple` emitter list — same shape.
    pub simple_emitters: Vec<JsonValue>,
    /// System-level groups (particleName, particlePath, flags, etc.)
    pub system: Vec<JsonValue>,
    /// Properties the troybin pipeline couldn't map to a modern BIN
    /// field. The reference Python tool serialised these into the
    /// human-readable trailer at the bottom of the .bin.py output;
    /// Jade drops that trailer (we don't pretend to be Troygrade), so
    /// the field is unused at the moment. Kept around so a future
    /// feature could log / surface them.
    #[allow(dead_code)]
    pub unknowns: Vec<String>,
}

// ── Main entry point ───────────────────────────────────────────────

pub fn create_bin(troybin: &TroybinData, default_file_path: &str) -> BinData {
    let bin_name = troybin.file_name.clone();
    let mut complex_emitters: Vec<JsonValue> = Vec::new();
    let mut simple_emitters: Vec<JsonValue> = Vec::new();

    for emitter in &troybin.emitters {
        let mut already_added: Vec<String> = Vec::new();
        let mut bin_emitters: Vec<JsonValue> = Vec::new();

        for prop in &emitter.properties {
            let prop_group = bg_name(prop).to_string();
            if already_added.contains(&prop_group) {
                continue;
            }

            // Collect properties for this group — siblings sharing the
            // same `binGroup.name` when the group has `members`, else
            // just this one property.
            let property_parts: Vec<&Property> = if !bg_members(prop).is_empty() {
                emitter
                    .properties
                    .iter()
                    .filter(|p| bg_name(p) == prop_group)
                    .collect()
            } else {
                vec![prop]
            };

            let parent_raw = bg_parent_value(prop);

            if parent_raw.is_some() {
                // Resolve list-of-parents → single dict. For primitive*
                // parents, pick the variant matching `p-type`.
                let mut parent: JsonValue = match parent_raw.unwrap() {
                    JsonValue::Array(arr) if !arr.is_empty() => {
                        let first_name = arr[0]
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if first_name.starts_with("primitive") {
                            // Find `p-type` property to know which one
                            let prim_value = emitter
                                .properties
                                .iter()
                                .find(|pp| pp.troybin_name == "p-type")
                                .and_then(|pp| {
                                    serde_json::to_value(&pp.value).ok()
                                });
                            if let Some(pv) = prim_value {
                                let pv_str = pv.as_str().unwrap_or("");
                                let correct = arr
                                    .iter()
                                    .find(|pp| {
                                        pp.get("name").and_then(|n| n.as_str())
                                            == Some(pv_str)
                                    })
                                    .cloned()
                                    .unwrap_or_else(|| arr[0].clone());
                                correct
                            } else {
                                arr[0].clone()
                            }
                        } else {
                            arr[0].clone()
                        }
                    }
                    JsonValue::Object(_) => parent_raw.unwrap().clone(),
                    _ => json!({}),
                };

                let parent_parent = parent.get("parent").cloned();

                // ── Complex parent-parent grouping ─────────────────
                // Used for field definitions + material overrides:
                // their parent has its own `members` listing sub-defs
                // (Acceleration / Drag / ...) whose members are the
                // actual properties.
                let is_field_or_material = match &parent_parent {
                    Some(JsonValue::Object(o)) => {
                        let name = o.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        name.starts_with("field") || name == "materialOverrideDefinitions"
                    }
                    _ => false,
                };

                if is_field_or_material {
                    let pp_obj = parent_parent.clone().unwrap();
                    let pp_name = pp_obj
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    let pp_order = pp_obj
                        .get("order")
                        .cloned()
                        .unwrap_or(JsonValue::from(0));
                    let pp_members = pp_obj
                        .get("members")
                        .cloned()
                        .unwrap_or(JsonValue::Array(Vec::new()));

                    let pp_members_arr = pp_members
                        .as_array()
                        .cloned()
                        .unwrap_or_default();

                    let mut pp_property_parts: Vec<JsonValue> = Vec::new();
                    for parent_member in pp_members_arr {
                        let pm_name = parent_member.as_str().unwrap_or("").to_string();
                        let parent_members: Vec<&Property> = emitter
                            .properties
                            .iter()
                            .filter(|p| parent_matches(p, &pm_name, &pp_name))
                            .collect();
                        if parent_members.is_empty() {
                            continue;
                        }
                        // Distinct definitionName values across these
                        // members (preserves Python's `set()` semantics
                        // and the order in which they first appear).
                        let mut def_groups: Vec<JsonValue> = Vec::new();
                        for m in &parent_members {
                            let dn = get_parent_attr(m, "definitionName");
                            if !def_groups.iter().any(|d| d == &dn) {
                                def_groups.push(dn);
                            }
                        }
                        let mut troybin_properties: Vec<JsonValue> = Vec::new();
                        for def_group in &def_groups {
                            let mut matching: Vec<JsonValue> = Vec::new();
                            for member in &parent_members {
                                if get_parent_attr(member, "definitionName") == *def_group {
                                    already_added.push(bg_name(member).to_string());
                                    // Rename frequency → period in
                                    // noise definitions.
                                    let mut mp = (*member).clone();
                                    if pm_name == "fieldNoiseDefinitions"
                                        && bg_name(&mp) == "frequency"
                                    {
                                        mp.bin_group.name = "period".to_string();
                                    }
                                    matching.push(json!({
                                        "name": bg_name(&mp),
                                        "members": [prop_to_json(&mp)],
                                        "order": bg_order(&mp),
                                    }));
                                }
                            }
                            // Default axisFraction for noise.
                            if pm_name == "fieldNoiseDefinitions"
                                && !matching.iter().any(|bp| {
                                    bp.get("name").and_then(|n| n.as_str())
                                        == Some("axisFraction")
                                })
                            {
                                matching.push(json!({
                                    "name": "axisFraction",
                                    "members": [{
                                        "troybin_name": "f-axisfrac",
                                        "troybin_type": "THREE_DOUBLE",
                                        "bin_group": {
                                            "name": "axisFraction",
                                            "members": [],
                                            "structure": "SimpleProperty",
                                            "order": 24.5,
                                            "parent": [{"name": "fieldNoiseDefinitions"}],
                                            "propertyType": "",
                                            "hasMembers": false,
                                        },
                                        "bin_group_type": "vec3",
                                        "bin_property_name": "",
                                        "bin_property_type": "",
                                        "value": [1, 1, 1],
                                    }],
                                    "order": 24.5,
                                }));
                            }
                            troybin_properties.push(JsonValue::Array(matching));
                        }
                        let name = get_parent_attr(parent_members[0], "name")
                            .as_str()
                            .unwrap_or("")
                            .to_string();
                        let order = get_parent_attr(parent_members[0], "order");
                        pp_property_parts.push(json!({
                            "name": name,
                            "members": troybin_properties,
                            "order": order,
                        }));
                    }
                    let final_property = json!({
                        "name": pp_name,
                        "members": pp_property_parts,
                        "order": pp_order,
                    });
                    bin_emitters.push(final_property);
                } else {
                    // ── Simple parent grouping ─────────────────────
                    if !parent.is_object() {
                        parent = json!({"name": "", "members": [], "order": 0});
                    }
                    let p_members = parent
                        .get("members")
                        .cloned()
                        .unwrap_or(JsonValue::Array(Vec::new()));
                    let p_members_arr = p_members
                        .as_array()
                        .cloned()
                        .unwrap_or_default();

                    if !p_members_arr.is_empty() {
                        let mut parent_parts: Vec<JsonValue> = Vec::new();
                        for pm in &p_members_arr {
                            let pm_name = pm.as_str().unwrap_or("").to_string();
                            let matching: Vec<&Property> = emitter
                                .properties
                                .iter()
                                .filter(|p| bg_name(p) == pm_name)
                                .collect();
                            if !matching.is_empty() {
                                for m in &matching {
                                    already_added.push(bg_name(m).to_string());
                                }
                                parent_parts.push(json!({
                                    "name": bg_name(matching[0]),
                                    "members": matching.iter().map(|m| prop_to_json(m)).collect::<Vec<_>>(),
                                    "order": bg_order(matching[0]),
                                }));
                            }
                        }
                        parent_parts.sort_by(|a, b| {
                            let ao = a.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let bo = b.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            ao.partial_cmp(&bo).unwrap_or(std::cmp::Ordering::Equal)
                        });
                        bin_emitters.push(json!({
                            "name": parent.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                            "members": parent_parts,
                            "order": parent.get("order").cloned().unwrap_or(JsonValue::from(0)),
                        }));
                    } else {
                        bin_emitters.push(json!({
                            "name": parent.get("name").and_then(|n| n.as_str()).unwrap_or(""),
                            "members": property_parts.iter().map(|p| prop_to_json(p)).collect::<Vec<_>>(),
                            "order": parent.get("order").cloned().unwrap_or(JsonValue::from(0)),
                        }));
                    }
                }
            } else {
                bin_emitters.push(json!({
                    "name": prop_group.clone(),
                    "members": property_parts.iter().map(|p| prop_to_json(p)).collect::<Vec<_>>(),
                    "order": bg_order(prop),
                }));
                already_added.push(prop_group);
            }
        }

        bin_emitters.sort_by(|a, b| {
            let ao = a.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let bo = b.get("order").and_then(|v| v.as_f64()).unwrap_or(0.0);
            ao.partial_cmp(&bo).unwrap_or(std::cmp::Ordering::Equal)
        });

        let block = JsonValue::Array(bin_emitters);
        if emitter.is_simple {
            simple_emitters.push(block);
        } else {
            complex_emitters.push(block);
        }
    }

    // ── System block ───────────────────────────────────────────────
    let mut flag_bits = [1u8, 0, 0, 0, 0, 1, 0, 0];
    let mut sys_props: Vec<JsonValue> = vec![
        json!({
            "name": "particleName",
            "members": [{
                "troybin_name": "",
                "troybin_type": "STRING_NO_PATH",
                "bin_group": {
                    "name": "particleName",
                    "members": [],
                    "structure": "SimpleProperty",
                    "order": 302,
                    "propertyType": "",
                    "hasMembers": false,
                },
                "bin_group_type": "string",
                "bin_property_name": "",
                "bin_property_type": "",
                "value": format!("\"{}\"", bin_name),
            }],
        }),
        json!({
            "name": "particlePath",
            "members": [{
                "troybin_name": "",
                "troybin_type": "STRING_PATH",
                "bin_group": {
                    "name": "particlePath",
                    "members": [],
                    "structure": "SimpleProperty",
                    "order": 303,
                    "propertyType": "",
                    "hasMembers": false,
                },
                "bin_group_type": "string",
                "bin_property_name": "",
                "bin_property_type": "",
                "value": format!("\"{}{}\"",
                    if default_file_path.is_empty() { String::new() } else { format!("{default_file_path}/") },
                    bin_name),
            }],
        }),
    ];

    for sp in &troybin.system {
        if sp.bin_group.name == "flags" {
            // `bin_property_name` is a 0..7 string index — the value
            // becomes that bit position.
            if let Ok(idx) = sp.bin_property_name.parse::<usize>() {
                if idx < 8 {
                    flag_bits[idx] = sp_value_as_bit(&serde_json::to_value(&sp.value).unwrap_or(JsonValue::Null));
                }
            }
        } else {
            sys_props.push(json!({
                "name": sp.bin_group.name.clone(),
                "members": [prop_to_json(sp)],
            }));
        }
    }

    // Bits assembled MSB-first.
    let flag_val: i64 = flag_bits.iter().fold(0i64, |acc, b| (acc << 1) | (*b as i64));
    sys_props.push(json!({
        "name": "flags",
        "members": [{
            "troybin_name": "",
            "troybin_type": "ONE_DOUBLE",
            "bin_group": {
                "name": "flags",
                "members": [],
                "structure": "SimpleProperty",
                "order": 307,
                "propertyType": "",
                "hasMembers": false,
            },
            "bin_group_type": "u16",
            "bin_property_name": "",
            "bin_property_type": "",
            "default_value": 196,
            "value": flag_val,
        }],
    }));

    sys_props.sort_by(|a, b| {
        let ao = a.pointer("/members/0/bin_group/order").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let bo = b.pointer("/members/0/bin_group/order").and_then(|v| v.as_f64()).unwrap_or(0.0);
        ao.partial_cmp(&bo).unwrap_or(std::cmp::Ordering::Equal)
    });

    BinData {
        name: bin_name,
        complex_emitters,
        simple_emitters,
        system: sys_props,
        unknowns: troybin.unknown.clone(),
    }
}

fn parent_matches(p: &Property, pm_name: &str, pp_name: &str) -> bool {
    match bg_parent_value(p) {
        None => false,
        Some(JsonValue::Object(o)) => {
            let name_ok = o.get("name").and_then(|n| n.as_str()) == Some(pm_name);
            let parent_name = o
                .get("parent")
                .and_then(|p| p.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            name_ok && parent_name == pp_name
        }
        Some(JsonValue::Array(arr)) => arr.iter().any(|pp| {
            if let JsonValue::Object(o) = pp {
                let name_ok = o.get("name").and_then(|n| n.as_str()) == Some(pm_name);
                let parent_name = o
                    .get("parent")
                    .and_then(|p| p.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("");
                name_ok && parent_name == pp_name
            } else {
                false
            }
        }),
        _ => false,
    }
}

fn sp_value_as_bit(v: &JsonValue) -> u8 {
    match v {
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i != 0 { 1 } else { 0 }
            } else if let Some(f) = n.as_f64() {
                if f != 0.0 { 1 } else { 0 }
            } else { 0 }
        }
        JsonValue::Bool(b) => if *b { 1 } else { 0 },
        JsonValue::Null => 0,
        _ => 0,
    }
}
