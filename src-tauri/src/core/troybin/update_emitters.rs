//! Stage 4: per-emitter value-level transformations.
//!
//! Direct port of `converter/update_emitters.py`. Takes the typed
//! emitter list stage 3 produced and rewrites property values to
//! match the modern ritobin shape:
//!
//! - Multiply `timesTable` entries by their constant value
//! - Insert default rotation axes when missing
//! - Multiply colour-table entries by their per-channel constant
//! - Fix the inline `primitive` placeholder name
//! - Inline material-override props into the baseTexture group
//! - Inline field emitter props (drag / accel / etc.) into the parent
//!   and drop the synthetic field emitter
//! - Split simple-emitter properties into a "normal" + "simple" pair
//! - Multiply complex-emitter table entries by the constant vector
//! - Append the default `p-linger` and (for simple emitters) the
//!   `p-disable-mesh-z` placeholder
//! - Duplicate multi-use emitters with renamed variants
//! - Drop emitters consumed as field sources
//! - Re-sort everything by `order`

use serde_json::{json, Value as JsonValue};

use super::read_troybin::{
    DefinitionId, Emitter, FormattedValueSerde as FV, Property, SvItemSerde,
};

/// `IntList` carries homogeneous int-typed lists — built when a
/// scalar `FV::Int` value gets duplicated into a multi-element list
/// (`[val, val]` in Python). Use this constructor where Python's
/// pipeline would keep ints; the `Numbers` variant is for actual
/// float-flavoured lists.
fn replicate_value(v: &FV, count: usize) -> FV {
    match v {
        FV::Int(i) => FV::IntList(vec![*i; count]),
        _ => FV::Numbers(vec![value_to_f64(v); count]),
    }
}
use super::values::BinGroup;

// ── Small accessors ────────────────────────────────────────────────

fn bg_name(p: &Property) -> &str {
    p.bin_group.name.as_str()
}

fn sv_text(p: &Property, idx: usize) -> String {
    match p.simple_value.get(idx) {
        Some(SvItemSerde::Text(s)) => s.clone(),
        _ => String::new(),
    }
}

fn sv_group(p: &Property, idx: usize) -> Option<BinGroup> {
    match p.simple_value.get(idx) {
        Some(SvItemSerde::Group(g)) => Some(g.clone()),
        _ => None,
    }
}

/// Python's `_sv_group_name(p)` — name of `simple_value[3]` when it's
/// a group, otherwise empty (`str(sv3)` would stringify a None/dict
/// awkwardly; we just return "" in those cases).
fn sv_group_name(p: &Property) -> String {
    sv_group(p, 3).map(|g| g.name).unwrap_or_default()
}

fn find_prop_index(props: &[Property], troybin_name: &str) -> Option<usize> {
    props.iter().position(|p| p.troybin_name == troybin_name)
}

// ── Value helpers ──────────────────────────────────────────────────

/// Best-effort "is this value the scalar -1?"
fn value_is_neg_one(v: &FV) -> bool {
    matches!(v, FV::Number(n) if *n == -1.0) || matches!(v, FV::Int(i) if *i == -1)
}

/// Pull a single f64 out of a value, defaulting to 0.0 if the shape
/// doesn't fit. Used for the scalar branches of various transforms.
fn value_to_f64(v: &FV) -> f64 {
    match v {
        FV::Number(n) => *n,
        FV::Int(i) => *i as f64,
        FV::Bool(b) => if *b { 1.0 } else { 0.0 },
        FV::Numbers(ns) => ns.first().copied().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Coerce a value into a `Vec<f64>` — `Numbers` flow through directly;
/// scalars become a one-element vec; anything else becomes empty.
fn value_to_vec_f64(v: &FV) -> Vec<f64> {
    match v {
        FV::Numbers(ns) => ns.clone(),
        FV::IntList(is) => is.iter().map(|i| *i as f64).collect(),
        FV::Number(n) => vec![*n],
        FV::Int(i) => vec![*i as f64],
        FV::Bool(b) => vec![if *b { 1.0 } else { 0.0 }],
        _ => Vec::new(),
    }
}

/// Python's `_check_value_type(value)` — `ONE_/TWO_/.../FIVE_DOUBLE`
/// based on list length, empty string when the value isn't a list.
fn check_value_type(v: &FV) -> &'static str {
    let len = match v {
        FV::Numbers(ns) => ns.len(),
        FV::IntList(is) => is.len(),
        _ => return "",
    };
    match len {
        1 => "ONE_DOUBLE",
        2 => "TWO_DOUBLE",
        3 => "THREE_DOUBLE",
        4 => "FOUR_DOUBLE",
        5 => "FIVE_DOUBLE",
        _ => "ONE_DOUBLE",
    }
}

/// Python's `_get_multi_name(name_prop)` — split the trailing digit and
/// return `(base, next_n)`. Matches behavior on the apostrophe-wrapped
/// name forms ("`PartA0`" → ("`PartA", 1)").
fn get_multi_name(name_prop: &str) -> (String, i64) {
    let bytes = name_prop.as_bytes();
    if let Some(&last) = bytes.last() {
        if last.is_ascii_digit() {
            let n = (last - b'0') as i64;
            return (name_prop[..name_prop.len() - 1].to_string(), n + 1);
        }
    }
    (name_prop.to_string(), 1)
}

// ── BinGroup ↔ JSON conversion (parent surgery uses JSON) ──────────

/// Serialise a `BinGroup` to its JSON form so we can write it into a
/// `parent` slot uniformly with the existing `Option<JsonValue>` shape.
fn bg_to_json(bg: &BinGroup) -> JsonValue {
    let mut obj = serde_json::Map::new();
    obj.insert("name".into(), JsonValue::String(bg.name.clone()));
    obj.insert("structure".into(), JsonValue::String(bg.structure.clone()));
    if bg.order.is_finite() && bg.order == bg.order.trunc() {
        obj.insert("order".into(), JsonValue::from(bg.order as i64));
    } else {
        obj.insert("order".into(), JsonValue::from(bg.order));
    }
    obj.insert("propertyType".into(), JsonValue::String(bg.property_type.clone()));
    obj.insert("hasMembers".into(), JsonValue::Bool(bg.has_members));
    obj.insert("members".into(), JsonValue::Array(
        bg.members.iter().map(|m| JsonValue::String(m.clone())).collect(),
    ));
    if let Some(p) = &bg.parent {
        obj.insert("parent".into(), p.clone());
    }
    JsonValue::Object(obj)
}

// ── Default `p-linger` factory ─────────────────────────────────────

fn make_p_linger(value: FV) -> Property {
    Property {
        troybin_name: "p-linger".to_string(),
        troybin_type: "ONE_DOUBLE".to_string(),
        bin_group: BinGroup {
            name: "particleLinger".to_string(),
            structure: "SimpleObjectProperty".to_string(),
            order: 15.0,
            property_type: String::new(),
            has_members: false,
            members: Vec::new(),
            parent: None,
        },
        bin_group_type: "option[f32]".to_string(),
        bin_property_name: "constantValue".to_string(),
        bin_property_type: String::new(),
        // Python's `10 + p_lifetime` keeps the int type when both
        // operands are int (i.e. no p-life present → default int 0)
        // and promotes to float as soon as a float p-lifetime is
        // added. Caller picks the matching `FV` variant.
        value,
        default_value: None,
        simple_value: Vec::new(),
        definition_id: None,
    }
}

fn make_p_disable_mesh_z() -> Property {
    Property {
        troybin_name: "p-disable-mesh-z".to_string(),
        troybin_type: "ONE_DOUBLE".to_string(),
        bin_group: BinGroup {
            name: "meshRenderFlags".to_string(),
            structure: "SimpleProperty".to_string(),
            order: 57.0,
            property_type: String::new(),
            has_members: false,
            members: Vec::new(),
            parent: None,
        },
        bin_group_type: "u8".to_string(),
        bin_property_name: String::new(),
        bin_property_type: String::new(),
        // Python emits `0` (int). Match.
        value: FV::Int(0),
        default_value: None,
        simple_value: Vec::new(),
        definition_id: None,
    }
}

fn make_rotation_axis(troybin_name: String) -> Property {
    Property {
        troybin_name,
        troybin_type: "THREE_DOUBLE".to_string(),
        bin_group: BinGroup {
            name: "emitRotationAxes".to_string(),
            structure: "SimpleObjectProperty".to_string(),
            order: 50.4,
            property_type: String::new(),
            has_members: false,
            members: vec![
                "e-rotation1-axis".to_string(),
                "e-rotation2-axis".to_string(),
                "e-rotation3-axis".to_string(),
            ],
            parent: Some(json!({
                "name": "shape",
                "members": ["birthTranslation", "emitOffset", "emitRotationAngles", "emitRotationAxes"],
                "structure": "",
                "order": 50,
            })),
        },
        bin_group_type: "list[vec3]".to_string(),
        bin_property_name: String::new(),
        bin_property_type: String::new(),
        value: FV::Numbers(vec![0.0, 1.000_000_12, 0.0]),
        default_value: None,
        simple_value: Vec::new(),
        definition_id: None,
    }
}

// ── Main entry ─────────────────────────────────────────────────────

pub fn update_emitters(data: &[Emitter]) -> Vec<Emitter> {
    if data.is_empty() {
        return Vec::new();
    }
    let troybin_data: Vec<Emitter> = data.to_vec();

    let mut emitters: Vec<Emitter> = Vec::new();
    let mut emitters_to_remove: Vec<String> = Vec::new();

    for emit in &troybin_data {
        let emitter = emit.clone();
        let mut properties_to_add: Vec<Property> = Vec::new();
        let mut properties_to_remove: Vec<String> = Vec::new();
        // Python's `update_emitters` builds a fresh `updated_emitter`
        // dict carrying only name/properties/order/isSimple — neither
        // `needsChanges` nor `isMultiUseEntry` survive. Mirror that:
        // start clean instead of preserving the input's flags.
        let mut updated_emitter = Emitter {
            name: emitter.name.clone(),
            properties: Vec::new(),
            order: emitter.order,
            is_simple: emitter.is_simple,
            needs_changes: false,
            is_multi_use_entry: Vec::new(),
        };
        let mut has_linger = false;

        for prop in &emitter.properties {
            let p = prop.clone();
            let bg = bg_name(&p).to_string();

            // ── e-life = -1: drop e-life (and p-life if no table) ──
            if bg == "lifetime" && value_is_neg_one(&p.value) {
                let has_table = find_prop_index(&emitter.properties, "p-lifeP").is_some()
                    || emitter
                        .properties
                        .iter()
                        .any(|pr| pr.troybin_name.contains("p-lifeP"));
                properties_to_remove.push("e-life".to_string());
                if !has_table {
                    properties_to_remove.push("p-life".to_string());
                }
            }

            // ── timesTable × constant for e-rate / p-life ──────────
            if matches!(p.troybin_name.as_str(), "e-rate" | "p-life") {
                let p_val = value_to_f64(&p.value);
                for j in 1..10 {
                    let tt_name = format!("{}{j}", p.troybin_name);
                    if let Some(idx) = find_prop_index(&emitter.properties, &tt_name) {
                        properties_to_remove.push(tt_name);
                        let mut tt = emitter.properties[idx].clone();
                        let mut v = value_to_vec_f64(&tt.value);
                        if v.len() >= 2 {
                            v[1] *= p_val;
                        }
                        tt.value = FV::Numbers(v);
                        properties_to_add.push(tt);
                    }
                }
            }

            // ── Rotation entries (e-rotation1..3) ──────────────────
            if matches!(
                p.troybin_name.as_str(),
                "e-rotation1" | "e-rotation2" | "e-rotation3"
            ) {
                let axis_name = format!("{}-axis", p.troybin_name);
                if let Some(idx) = find_prop_index(&emitter.properties, &axis_name) {
                    properties_to_remove.push(axis_name.clone());
                    let mut axis = emitter.properties[idx].clone();
                    let mut v = value_to_vec_f64(&axis.value);
                    // Replace exact 1.0 with 1.00000012 — the engine
                    // treats axis components of exactly 1 as a
                    // "default" sentinel, so we nudge slightly off.
                    for n in v.iter_mut() {
                        if *n == 1.0 {
                            *n = 1.000_000_12;
                        }
                    }
                    axis.value = FV::Numbers(v);
                    properties_to_add.push(axis);
                } else {
                    properties_to_add.push(make_rotation_axis(axis_name));
                }
            }

            // ── Track linger so we can default it later ────────────
            if bg == "particleLinger" {
                has_linger = true;
            }

            // ── Colour-table multiply ─────────────────────────────
            if matches!(
                p.troybin_name.as_str(),
                "p-xrgba" | "e-rgba" | "p-bindtoemitter"
            ) {
                let val = value_to_vec_f64(&p.value);
                let color_not_default = val.len() >= 4
                    && (val[0] != 1.0 || val[1] != 1.0 || val[2] != 1.0 || val[3] != 1.0);
                if color_not_default {
                    for j in 1..21 {
                        let pname = format!("{}{j}", p.troybin_name);
                        if let Some(idx) = find_prop_index(&emitter.properties, &pname) {
                            properties_to_remove.push(pname);
                            let mut tt = emitter.properties[idx].clone();
                            let tt_val = value_to_vec_f64(&tt.value);
                            let mut new_val: Vec<f64> = Vec::with_capacity(5);
                            if !tt_val.is_empty() {
                                new_val.push(tt_val[0]);
                            }
                            for k in 1..5 {
                                if k < tt_val.len() {
                                    new_val.push(tt_val[k] * val[k - 1]);
                                }
                            }
                            tt.value = FV::Numbers(new_val);
                            properties_to_add.push(tt);
                        }
                    }
                }
            }

            // ── primitive placeholder name fix ─────────────────────
            if bg == "primitive" {
                if let FV::Str(s) = &p.value {
                    if matches!(s.as_str(), "primitiveArbitraryQuad" | "primitiveRay") {
                        let mut prim = p.clone();
                        prim.bin_group.name = s.clone();
                        properties_to_add.push(prim);
                    }
                }
            }

            // ── Material overrides: pull sibling props ─────────────
            if bg == "baseTexture" {
                let parent_name = parent_first_name(&p.bin_group);
                let def_id = p.definition_id.clone();
                let material_props: Vec<Property> = emit
                    .properties
                    .iter()
                    .filter(|mp| {
                        // Parent must be a non-empty list and first
                        // entry's `name` matches `parent_name`.
                        let pn = match &mp.bin_group.parent {
                            Some(JsonValue::Array(arr)) => arr
                                .first()
                                .and_then(|v| v.get("name"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .unwrap_or_default(),
                            _ => String::new(),
                        };
                        if pn != parent_name {
                            return false;
                        }
                        // definitionId must be absent or match this
                        // baseTexture's definitionId.
                        match (&mp.definition_id, &def_id) {
                            (None, _) => true,
                            (Some(a), Some(b)) => def_eq(a, b),
                            (Some(_), None) => false,
                        }
                    })
                    .cloned()
                    .collect();

                for mut mp in material_props {
                    properties_to_remove.push(mp.troybin_name.clone());
                    // parent: [obj] → obj
                    if let Some(JsonValue::Array(arr)) = &mp.bin_group.parent {
                        if let Some(first) = arr.first() {
                            mp.bin_group.parent = Some(first.clone());
                        }
                    }
                    // Inject definitionName onto the resulting object.
                    if let Some(JsonValue::Object(obj)) = mp.bin_group.parent.as_mut() {
                        if let Some(d) = &def_id {
                            obj.insert("definitionName".into(), def_id_json(d));
                        }
                    }
                    properties_to_add.push(mp);
                }
            }

            // ── Field inlining ─────────────────────────────────────
            if !bg.is_empty() && bg.starts_with("field") && bg.to_ascii_lowercase().contains("field")
            {
                let val_str = value_as_quoted_string(&p.value);
                let mut field_emitter_idx: Option<usize> = None;
                for (fi, fe) in troybin_data.iter().enumerate() {
                    let quoted = format!("\"{}\"", fe.name);
                    let alt = format!("'{val_str}");
                    if quoted == val_str || quoted == alt {
                        field_emitter_idx = Some(fi);
                        break;
                    }
                }
                if let Some(idx) = field_emitter_idx {
                    let field_emitter = &troybin_data[idx];
                    if p.definition_id.is_none() {
                        for fp in &field_emitter.properties {
                            let mut field_prop = fp.clone();
                            // `f-accel` scalar gets coerced to a Value/Float
                            // shape (binGroup.propertyType + binPropertyType).
                            if field_prop.troybin_name == "f-accel"
                                && matches!(field_prop.value, FV::Number(_) | FV::Int(_))
                            {
                                field_prop.bin_group.property_type = "ValueFloat".into();
                                field_prop.bin_property_type = "f32".into();
                            }
                            // Pick the parent entry whose `name` matches
                            // the field group we're inlining into.
                            if let Some(JsonValue::Array(arr)) = &field_prop.bin_group.parent {
                                let correct = arr
                                    .iter()
                                    .find(|pp| pp.get("name").and_then(|n| n.as_str()) == Some(&bg));
                                if let Some(pp) = correct {
                                    field_prop.bin_group.parent = Some(pp.clone());
                                }
                            }
                            if let Some(JsonValue::Object(obj)) = field_prop.bin_group.parent.as_mut()
                            {
                                obj.insert(
                                    "definitionName".into(),
                                    JsonValue::String(field_emitter.name.clone()),
                                );
                            }
                            properties_to_add.push(field_prop);
                        }
                    }
                    if !emitters_to_remove.contains(&field_emitter.name) {
                        emitters_to_remove.push(field_emitter.name.clone());
                    }
                }
                properties_to_remove.push(p.troybin_name.clone());
            }

            // ── Simple-emitter handling ────────────────────────────
            if emitter.is_simple {
                let is_simple_property = !p.simple_value.is_empty();
                let mut normal_property: Option<Property> = None;
                let mut simple_property: Option<Property> = None;

                if is_simple_property {
                    let is_lifetime = bg == "particleLifetime";
                    let has_both = is_lifetime
                        && find_prop_index(&emitter.properties, "p-lifeP1").is_some()
                        && find_prop_index(&emitter.properties, "p-life1").is_some();

                    if !is_lifetime || has_both {
                        let pn = p.bin_property_name.as_str();
                        if pn == "constantValue" || bg == "scaleBias" {
                            let val_vec = value_to_vec_f64(&p.value);
                            let value_type = check_value_type(&p.value);
                            let mut n_bin_type = p.bin_property_type.clone();
                            let s_bin_type = sv_text(&p, 2);

                            let (n_value, s_value): (FV, FV);
                            if value_type == p.troybin_type {
                                if bg == "scaleBias" {
                                    n_value = p.value.clone();
                                    s_value = p.value.clone();
                                } else {
                                    n_value = p.value.clone();
                                    let mut sv: f64 = val_vec.first().copied().unwrap_or(0.0);
                                    if !val_vec.is_empty() && val_vec[0] == 0.0 {
                                        if val_vec.len() > 1 && val_vec[1] != 0.0 {
                                            sv = val_vec[1];
                                        } else if val_vec.len() > 2 && val_vec[2] != 0.0 {
                                            sv = val_vec[2];
                                        }
                                    }
                                    s_value = if val_vec.is_empty() {
                                        p.value.clone()
                                    } else {
                                        FV::Number(sv)
                                    };
                                }
                            } else if bg == "birthRotationalVelocity0" || bg == "birthRotation0" {
                                if val_vec.is_empty() {
                                    n_value = p.value.clone();
                                    s_value = p.value.clone();
                                } else {
                                    if matches!(p.value, FV::Numbers(_)) {
                                        n_value = p.value.clone();
                                        s_value = FV::Number(val_vec[0]);
                                    } else {
                                        n_value = FV::Numbers(vec![val_vec[0], 0.0, 0.0]);
                                        s_value = FV::Number(val_vec[0]);
                                    }
                                }
                            } else if bg == "bindWeight" {
                                if matches!(p.value, FV::Numbers(_) | FV::IntList(_)) {
                                    n_value = p.value.clone();
                                    s_value = p.value.clone();
                                } else {
                                    n_value = p.value.clone();
                                    // Preserve int-ness when val is an
                                    // Int — Python's `[int, int]` stays
                                    // an int list in the JSON dump.
                                    s_value = replicate_value(&p.value, 2);
                                }
                            } else if matches!(p.value, FV::Numbers(_) | FV::IntList(_)) {
                                n_value = p.value.clone();
                                s_value = FV::Number(val_vec.first().copied().unwrap_or(0.0));
                                n_bin_type = "vec3".into();
                            } else {
                                let v = value_to_f64(&p.value);
                                n_value = replicate_value(&p.value, 3);
                                s_value = FV::Number(v);
                                n_bin_type = "vec3".into();
                            }

                            let mut np = p.clone();
                            np.value = n_value;
                            np.bin_property_type = n_bin_type;
                            normal_property = Some(np);

                            simple_property = Some(Property {
                                troybin_name: p.troybin_name.clone(),
                                troybin_type: sv_text(&p, 0),
                                bin_group: sv_group(&p, 3).unwrap_or_default(),
                                bin_group_type: sv_text(&p, 1),
                                bin_property_name: if bg == "bindWeight" {
                                    String::new()
                                } else {
                                    p.bin_property_name.clone()
                                },
                                bin_property_type: s_bin_type,
                                value: s_value,
                                default_value: None,
                                simple_value: Vec::new(),
                                definition_id: None,
                            });
                        } else {
                            // Non-constantValue (probTable / timesTable shape)
                            let mut complex_value = p.value.clone();
                            let simple_value = p.value.clone();
                            let sv4 = sv_text(&p, 4);
                            let sv4_is_times_table =
                                sv4.contains("timesTable") && bg != "particleLifetime";

                            if sv4_is_times_table {
                                let v = value_to_vec_f64(&complex_value);
                                if v.len() >= 2 {
                                    complex_value =
                                        FV::Numbers(vec![v[0], v[1], v[1], v[1]]);
                                }
                            }

                            let n_bin_property_type = if sv4.contains("timesTable") {
                                p.bin_property_type.clone()
                            } else {
                                sv_text(&p, 2)
                            };

                            let np = Property {
                                troybin_name: p.troybin_name.clone(),
                                troybin_type: sv_text(&p, 0),
                                bin_group: p.bin_group.clone(),
                                bin_group_type: p.bin_group_type.clone(),
                                bin_property_name: sv4.clone(),
                                bin_property_type: n_bin_property_type,
                                value: complex_value,
                                default_value: None,
                                simple_value: Vec::new(),
                                definition_id: None,
                            };
                            normal_property = Some(np);

                            let sv3_name = sv_group_name(&p);
                            if bg != sv3_name {
                                let mut simple_value = simple_value;
                                if sv4_is_times_table {
                                    // Strip trailing digit then optional P
                                    let mut const_name = p.troybin_name.clone();
                                    if !const_name.is_empty() {
                                        const_name.pop();
                                    }
                                    if const_name.ends_with('P') {
                                        const_name.pop();
                                    }
                                    if let Some(cidx) =
                                        find_prop_index(&emitter.properties, &const_name)
                                    {
                                        let const_prop = &emitter.properties[cidx];
                                        let cv = value_to_f64(&const_prop.value);
                                        let v = value_to_vec_f64(&simple_value);
                                        if v.len() >= 2 {
                                            simple_value = FV::Numbers(vec![v[0], v[1] * cv]);
                                        }
                                    }
                                }
                                simple_property = Some(Property {
                                    troybin_name: p.troybin_name.clone(),
                                    troybin_type: sv_text(&p, 0),
                                    bin_group: sv_group(&p, 3).unwrap_or_default(),
                                    bin_group_type: sv_text(&p, 1),
                                    bin_property_name: sv4,
                                    bin_property_type: sv_text(&p, 2),
                                    value: simple_value,
                                    default_value: None,
                                    simple_value: Vec::new(),
                                    definition_id: None,
                                });
                            }
                        }

                        if let Some(sp) = simple_property {
                            const SKIP_NORMAL: &[&str] = &[
                                "birthScale",
                                "scale",
                                "birthRotation",
                                "birthRotationalVelocity",
                                "particleBind",
                                "scaleBias",
                                "orientation",
                            ];
                            let sp_name = sp.bin_group.name.as_str();
                            if !SKIP_NORMAL.contains(&sp_name) {
                                if let Some(np) = normal_property {
                                    properties_to_add.push(np);
                                }
                            }
                            properties_to_add.push(sp);
                        } else if let Some(np) = normal_property {
                            properties_to_add.push(np);
                        }
                        properties_to_remove.push(p.troybin_name.clone());
                    }
                }
            } else {
                // ── Complex-emitter table × constant ───────────────
                const CHECK_PROPS: &[&str] = &[
                    "p-quadrot",
                    "p-rotvel",
                    "p-scale",
                    "p-worldaccel",
                    "p-xquadrot",
                    "p-xscale",
                    "Particle-Velocity",
                    "Particle-Drag",
                ];
                if CHECK_PROPS.contains(&p.troybin_name.as_str()) {
                    let val_vec = value_to_vec_f64(&p.value);
                    let const_vec: Vec<f64> = if matches!(p.value, FV::Numbers(_)) {
                        val_vec.clone()
                    } else {
                        let s = value_to_f64(&p.value);
                        vec![s, s, s]
                    };
                    let not_default = const_vec
                        .iter()
                        .take(3)
                        .any(|v| *v != 1.0);
                    if not_default {
                        for j in 1..10 {
                            let pname = format!("{}{j}", p.troybin_name);
                            if let Some(idx) = find_prop_index(&emitter.properties, &pname) {
                                properties_to_remove.push(pname);
                                let mut tt = emitter.properties[idx].clone();
                                let tt_vals = value_to_vec_f64(&tt.value);
                                let mut new_val: Vec<f64> = Vec::with_capacity(4);
                                if !tt_vals.is_empty() {
                                    new_val.push(tt_vals[0]);
                                }
                                for k in 1..4 {
                                    let tv = tt_vals.get(k).copied().unwrap_or(0.0);
                                    let cv = const_vec.get(k - 1).copied().unwrap_or(0.0);
                                    new_val.push(tv * cv);
                                }
                                tt.value = FV::Numbers(new_val);
                                properties_to_add.push(tt);
                            }
                        }
                    }
                }
            }
        }

        // ── Default p-linger ───────────────────────────────────────
        // Type-preservation: Python computes `10 + p_lifetime` with
        // its native dynamic typing — int+int stays int (no p-life
        // present, default 0), int+float becomes float (p-life
        // present, which is always Number/Numbers from stage 3).
        // We pick the matching FV variant explicitly.
        if !has_linger && !emitter.is_simple {
            let value = match find_prop_index(&emitter.properties, "p-life") {
                Some(i) => FV::Number(10.0 + value_to_f64_or_first(&emitter.properties[i].value)),
                None => FV::Int(10),
            };
            properties_to_add.push(make_p_linger(value));
        }
        if emitter.is_simple {
            if !has_linger {
                properties_to_add.push(make_p_linger(FV::Int(10)));
            }
            properties_to_add.push(make_p_disable_mesh_z());
        }

        // ── Apply removals + additions ─────────────────────────────
        for p in &emitter.properties {
            if !properties_to_remove.contains(&p.troybin_name) {
                updated_emitter.properties.push(p.clone());
            }
        }
        for p in properties_to_add {
            updated_emitter.properties.push(p);
        }

        let saved_multi = emitter.is_multi_use_entry.clone();
        let saved_name = emitter.name.clone();
        let saved_props_for_multi = updated_emitter.properties.clone();
        emitters.push(updated_emitter);

        if !saved_multi.is_empty() {
            let (ename, num) = get_multi_name(&saved_name);
            for (i, order_val) in saved_multi.iter().enumerate() {
                let new_name = format!("\"{ename}{}\"", num + i as i64);
                let new_props =
                    rewrite_emitter_name_value(&saved_props_for_multi, &new_name);
                emitters.push(Emitter {
                    name: new_name,
                    properties: new_props,
                    order: *order_val,
                    is_simple: false,
                    needs_changes: false,
                    is_multi_use_entry: Vec::new(),
                });
            }
        }
    }

    // Filter + sort
    let mut result: Vec<Emitter> = emitters
        .into_iter()
        .filter(|e| !emitters_to_remove.contains(&e.name))
        .collect();
    result.sort_by(|a, b| a.order.cmp(&b.order));
    result
}

// ── Smaller helpers used by the main routine ───────────────────────

fn value_to_f64_or_first(v: &FV) -> f64 {
    match v {
        FV::Numbers(ns) => ns.first().copied().unwrap_or(0.0),
        _ => value_to_f64(v),
    }
}

/// Stringify the value to the form `update_emitters.py` compares
/// against (`"name"`). Numeric / list values won't match; only
/// strings matter for field-emitter discovery.
fn value_as_quoted_string(v: &FV) -> String {
    match v {
        FV::Str(s) => s.clone(),
        FV::Strings(ss) => ss.join(" "),
        _ => String::new(),
    }
}

fn parent_first_name(bg: &BinGroup) -> String {
    match &bg.parent {
        Some(JsonValue::Array(arr)) => arr
            .first()
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Some(JsonValue::Object(obj)) => obj
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn def_eq(a: &DefinitionId, b: &DefinitionId) -> bool {
    match (a, b) {
        (DefinitionId::Bool(x), DefinitionId::Bool(y)) => x == y,
        (DefinitionId::Str(x), DefinitionId::Str(y)) => x == y,
        _ => false,
    }
}

fn def_id_json(d: &DefinitionId) -> JsonValue {
    match d {
        DefinitionId::Bool(b) => JsonValue::Bool(*b),
        DefinitionId::Str(s) => JsonValue::String(s.clone()),
    }
}

/// Port of `_get_new_properties` — overwrite `value` on any property
/// whose `binGroup.name == "emitterName"` with the supplied emitter
/// name (already wrapped in quotes by the caller).
fn rewrite_emitter_name_value(props: &[Property], emitter_name: &str) -> Vec<Property> {
    props
        .iter()
        .map(|p| {
            let mut np = p.clone();
            if np.bin_group.name == "emitterName" {
                np.value = FV::Str(emitter_name.to_string());
            }
            np
        })
        .collect()
}

#[allow(dead_code)]
fn _ensure_used_helpers() {
    let _ = bg_to_json;
}
