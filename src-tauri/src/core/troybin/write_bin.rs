//! Stage 5b: ritobin text emitter.
//!
//! Direct port of `converter/write_bin.py`. Walks the `BinData` tree
//! [`create_bin`] produces and emits Riot's ritobin text format
//! (`#PROP_text` header, indented braces, CRLF line endings).

use serde_json::Value as JsonValue;

use super::create_bin::BinData;

fn sp(n: usize) -> String {
    "    ".repeat(n)
}

/// Format a single scalar value — `_fmt_num` in Python. Booleans go
/// to `true`/`false`, integer-valued floats lose their trailing `.0`,
/// null becomes `0`.
fn fmt_num(v: &JsonValue) -> String {
    match v {
        JsonValue::Bool(b) => if *b { "true".into() } else { "false".into() },
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                return i.to_string();
            }
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f == f.trunc() && f.abs() < 1e15 {
                    return (f as i64).to_string();
                }
                return python_float_str(f);
            }
            "0".into()
        }
        JsonValue::Null => "0".into(),
        JsonValue::String(s) => s.clone(),
        JsonValue::Array(arr) => {
            // Shouldn't normally happen for `_fmt_num`, but mirror
            // Python's `str(v)` fallback.
            arr.iter().map(fmt_num).collect::<Vec<_>>().join(", ")
        }
        JsonValue::Object(_) => "{}".into(),
    }
}

/// Python's `str(float)` — drops trailing `.0`? No, Python keeps it.
/// In `_fmt_num` we already handle the integer-valued case before
/// reaching here, so this is for actual fractional floats.
fn python_float_str(f: f64) -> String {
    if f.is_nan() { return "nan".into(); }
    if f.is_infinite() {
        return if f.is_sign_negative() { "-inf".into() } else { "inf".into() };
    }
    let s = format!("{}", f);
    if s.contains('.') || s.contains('e') || s.contains('E') {
        s
    } else {
        format!("{s}.0")
    }
}

/// Python's `str(value)` — used by `SimpleObjectProperty`'s outer
/// wrapper comparison where the float `.0` and int distinction is
/// preserved (unlike `_get_value` / `fmt_num` which normalises whole
/// floats to ints). Critical for cases like `value=0.0, default=0`
/// where Python emits an empty wrapper block even though the inner
/// value gets elided.
/// Python `==` over two JSON values — promotes ints and floats so
/// `0 == 0.0` (which serde_json's PartialEq treats as different
/// variants). Used wherever the reference compares a parsed value
/// against a `defaultValue` from `values.json`.
fn python_eq(a: &JsonValue, b: &JsonValue) -> bool {
    use JsonValue::*;
    match (a, b) {
        (Number(x), Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

fn python_str(v: &JsonValue) -> String {
    match v {
        JsonValue::Bool(b) => (if *b { "True" } else { "False" }).to_string(),
        JsonValue::Null => "None".to_string(),
        JsonValue::String(s) => s.clone(),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                return i.to_string();
            }
            if let Some(f) = n.as_f64() {
                return python_float_str(f);
            }
            n.to_string()
        }
        _ => v.to_string(),
    }
}

/// Format a member's `value` — `_get_value` in Python. Lists wrap in
/// `{ … }`; everything else flows through `fmt_num`.
///
/// Divergence from the reference: when the member's `bin_property_type`
/// is `vec2` / `vec3` / `vec4` and the value array is shorter than
/// that, we pad with `1.0` instead of emitting an under-sized list.
/// Source troybins occasionally store only 2 components for a vec4
/// colour and the Python tool's `COLOR_DOUBLE` formatter falls back
/// to `TWO_DOUBLE`, producing `vec4 = { 1, 1 }` — which then refuses
/// to round-trip through Jade's BIN compiler. Padding with `1.0`
/// mirrors the convention the reference already uses for the missing-
/// alpha case in `FIVE_DOUBLE` (`return nums + [1.0]`).
fn get_value(member: &JsonValue) -> String {
    get_value_with_pad_flag(member).0
}

/// Same as `get_value` but also reports whether the value was padded
/// out to its expected vec width. Callers use the flag to skip the
/// default-equality elision — we don't want to drop a property line
/// just because the padded value happens to equal the static default,
/// since that would lose the source-of-truth signal that the input
/// had a (malformed) explicit value.
fn get_value_with_pad_flag(member: &JsonValue) -> (String, bool) {
    let val = match member.get("value") {
        Some(v) if !v.is_null() => v,
        _ => return (String::new(), false),
    };
    match val {
        JsonValue::Bool(b) => ((if *b { "true" } else { "false" }).to_string(), false),
        JsonValue::Array(arr) => {
            let expected = vec_component_count(member);
            let mut items: Vec<JsonValue> = arr.clone();
            let mut padded = false;
            if let Some(n) = expected {
                while items.len() < n {
                    items.push(JsonValue::from(1.0));
                    padded = true;
                }
            }
            let body: Vec<String> = items.iter().map(fmt_num).collect();
            (format!("{{ {} }}", body.join(", ")), padded)
        }
        JsonValue::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f == f.trunc() && f.abs() < 1e15 {
                    return ((f as i64).to_string(), false);
                }
            }
            (fmt_num(val), false)
        }
        JsonValue::String(s) => (s.clone(), false),
        _ => (fmt_num(val), false),
    }
}

/// Read the expected component count from a member's `bin_property_type`
/// (`vec2` → 2, `vec3` → 3, `vec4` → 4). Returns `None` for non-vec
/// types — those flow through unmodified.
fn vec_component_count(member: &JsonValue) -> Option<usize> {
    match member_str(member, "bin_property_type").as_str() {
        "vec2" => Some(2),
        "vec3" => Some(3),
        "vec4" => Some(4),
        _ => None,
    }
}

fn bg(prop: &JsonValue) -> JsonValue {
    prop.get("bin_group").cloned().unwrap_or(JsonValue::Object(Default::default()))
}

fn bg_name(prop: &JsonValue) -> String {
    bg(prop).get("name").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn member_str(m: &JsonValue, field: &str) -> String {
    m.get(field).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn members_of(prop: &JsonValue) -> Vec<JsonValue> {
    prop.get("members")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn name_of(prop: &JsonValue) -> String {
    prop.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

// ── _write_constant_value ──────────────────────────────────────────

fn write_constant_value(
    prop_or_list: &JsonValue,
    sp_n: usize,
    is_mult: bool,
    value_only: bool,
) -> (String, Vec<String>) {
    let members: Vec<JsonValue> = if is_mult {
        members_of(prop_or_list)
    } else if let JsonValue::Array(arr) = prop_or_list {
        arr.clone()
    } else {
        vec![prop_or_list.clone()]
    };
    let mut result: Vec<String> = Vec::new();
    let mut return_const = String::new();

    for (i, member) in members.iter().enumerate() {
        let (cv, was_padded) = get_value_with_pad_flag(member);
        if i == 0 {
            return_const = cv.clone();
        }
        let dv = member.get("default_value");
        let dv_str = match dv {
            Some(JsonValue::Null) | None => String::new(),
            Some(v) => fmt_num(v),
        };
        // Emit when the value differs from the default OR when we had
        // to pad the value out to its declared vec width — padding
        // implies the source troybin stored an explicit (under-sized)
        // value, so we keep the line in the output even if it
        // coincidentally equals the default after padding.
        if cv != dv_str || was_padded {
            if value_only {
                result.push(format!("{}{}\r\n", sp(sp_n), cv));
            } else {
                let pn = member_str(member, "bin_property_name");
                let pt = member_str(member, "bin_property_type");
                if !pn.is_empty() && !pt.is_empty() {
                    result.push(format!("{}{}: {} = {}\r\n", sp(sp_n), pn, pt, cv));
                }
            }
        }
    }

    (return_const, result)
}

// ── _write_prob_table ──────────────────────────────────────────────

fn write_prob_table(entries: &[JsonValue], sp_n: usize, prop_type: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    out.push(format!("{}VfxProbabilityTableData {{\r\n", sp(sp_n)));
    out.push(format!("{}keyTimes: list[f32] = {{\r\n", sp(sp_n + 1)));
    for pt in entries {
        let v = pt.get("value").cloned().unwrap_or(JsonValue::from(0));
        let cell = match &v {
            JsonValue::Array(arr) if !arr.is_empty() => fmt_num(&arr[0]),
            _ => fmt_num(&v),
        };
        out.push(format!("{}{}\r\n", sp(sp_n + 2), cell));
    }
    out.push(format!("{}}}\r\n", sp(sp_n + 1)));
    out.push(format!("{}keyValues: list[{}] = {{\r\n", sp(sp_n + 1), prop_type));
    for pt in entries {
        let v = pt.get("value").cloned().unwrap_or(JsonValue::Array(vec![JsonValue::from(0), JsonValue::from(0)]));
        match &v {
            JsonValue::Array(arr) => {
                if arr.len() >= 2 {
                    let val = &arr[1];
                    if let JsonValue::Array(inner) = val {
                        let body: Vec<String> = inner.iter().map(|x| match x {
                            JsonValue::Number(_) | JsonValue::Bool(_) => fmt_num(x),
                            _ => x.to_string(),
                        }).collect();
                        out.push(format!("{}{{ {} }}\r\n", sp(sp_n + 2), body.join(", ")));
                    } else {
                        out.push(format!("{}{}\r\n", sp(sp_n + 2), fmt_num(val)));
                    }
                } else if !arr.is_empty() {
                    out.push(format!("{}{}\r\n", sp(sp_n + 2), fmt_num(&arr[0])));
                }
            }
            _ => out.push(format!("{}{}\r\n", sp(sp_n + 2), fmt_num(&v))),
        }
    }
    out.push(format!("{}}}\r\n", sp(sp_n + 1)));
    out.push(format!("{}}}\r\n", sp(sp_n)));
    out
}

// ── _write_dynamics ────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn write_dynamics(
    const_value: &str,
    prop: &JsonValue,
    prob_x: &[JsonValue],
    prob_y: &[JsonValue],
    prob_z: &[JsonValue],
    prob_a: &[JsonValue],
    sp_n: usize,
    times_t: &[JsonValue],
    times_simple: &[JsonValue],
    write_empty: bool,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    let has_prob = !prob_x.is_empty() || !prob_y.is_empty() || !prob_z.is_empty() || !prob_a.is_empty();

    if has_prob {
        let mut dyn_type = String::new();
        for lst in [prob_x, prob_y, prob_z, prob_a] {
            if let Some(first) = lst.first() {
                dyn_type = member_str(first, "bin_group_type");
                break;
            }
        }
        out.push(format!("{}dynamics: {} {{\r\n", sp(sp_n), dyn_type));
        out.push(format!("{}probabilityTables: list[pointer] = {{\r\n", sp(sp_n + 1)));

        let members_list = members_of(prop);
        let prop_type = members_list
            .first()
            .map(|m| bg(m).get("propertyType").and_then(|v| v.as_str()).unwrap_or("").to_string())
            .unwrap_or_default();
        let bin_property_type_first = members_list
            .first()
            .map(|m| member_str(m, "bin_property_type"))
            .unwrap_or_default();
        let is_vec3 = prop_type.contains("Vector3") || bin_property_type_first.contains("vec3");
        let is_color = prop_type.contains("Color");
        let can_y = is_vec3 || is_color || !prob_y.is_empty();
        let can_z = is_vec3 || is_color || !prob_z.is_empty();
        let can_a = is_color || !prob_a.is_empty();

        for (axis_data, can_have) in [
            (prob_x, true),
            (prob_y, can_y),
            (prob_z, can_z),
            (prob_a, can_a),
        ] {
            if !axis_data.is_empty() {
                let pt = member_str(&axis_data[0], "bin_property_type");
                let pt = if pt.is_empty() { "f32".to_string() } else { pt };
                out.extend(write_prob_table(axis_data, sp_n + 2, &pt));
            } else if can_have && write_empty {
                out.push(format!("{}VfxProbabilityTableData {{}}\r\n", sp(sp_n + 2)));
            }
        }
        out.push(format!("{}}}\r\n", sp(sp_n + 1)));
    } else {
        let mut tt_type = String::new();
        if let Some(t) = times_simple.first() {
            tt_type = member_str(t, "bin_group_type");
            if tt_type.is_empty() {
                tt_type = "pointer = VfxAnimatedVector3fVariableData".into();
            }
        }
        if let Some(t) = times_t.first() {
            let v = member_str(t, "bin_group_type");
            if !v.is_empty() { tt_type = v; }
        }
        if tt_type.is_empty() {
            tt_type = "pointer = VfxAnimatedVector3fVariableData".into();
        }
        out.push(format!("{}dynamics: {} {{\r\n", sp(sp_n), tt_type));
    }

    out.push(format!("{}times: list[f32] = {{\r\n", sp(sp_n + 1)));

    let has_times = !times_t.is_empty() || !times_simple.is_empty();
    if has_times {
        let tt_entries: &[JsonValue] = if !times_t.is_empty() { times_t } else { times_simple };
        for t in tt_entries {
            let v = t.get("value").cloned().unwrap_or(JsonValue::from(0));
            let cell = match &v {
                JsonValue::Array(arr) if !arr.is_empty() => fmt_num(&arr[0]),
                _ => fmt_num(&v),
            };
            out.push(format!("{}{}\r\n", sp(sp_n + 2), cell));
        }
        out.push(format!("{}}}\r\n", sp(sp_n + 1)));

        let vtype = member_str(&tt_entries[0], "bin_property_type");
        let vtype = if vtype.is_empty() { "f32".to_string() } else { vtype };
        out.push(format!("{}values: list[{}] = {{\r\n", sp(sp_n + 1), vtype));
        for t in tt_entries {
            let v = t.get("value").cloned().unwrap_or(JsonValue::from(0));
            match &v {
                JsonValue::Array(arr) => {
                    let cell = match arr.len() {
                        5 => format!("{{ {}, {}, {}, {} }}", fmt_num(&arr[1]), fmt_num(&arr[2]), fmt_num(&arr[3]), fmt_num(&arr[4])),
                        4 => format!("{{ {}, {}, {} }}", fmt_num(&arr[1]), fmt_num(&arr[2]), fmt_num(&arr[3])),
                        3 => format!("{{ {}, {} }}", fmt_num(&arr[1]), fmt_num(&arr[2])),
                        2 => fmt_num(&arr[1]),
                        1 => fmt_num(&arr[0]),
                        _ => String::new(),
                    };
                    if !cell.is_empty() {
                        out.push(format!("{}{}\r\n", sp(sp_n + 2), cell));
                    }
                }
                _ => out.push(format!("{}{}\r\n", sp(sp_n + 2), fmt_num(&v))),
            }
        }
        out.push(format!("{}}}\r\n", sp(sp_n + 1)));
        out.push(format!("{}}}\r\n", sp(sp_n)));
    } else {
        let members_list = members_of(prop);
        let const_entry = members_list
            .iter()
            .find(|m| member_str(m, "bin_property_name") == "constantValue");
        let ctype = const_entry
            .map(|m| member_str(m, "bin_property_type"))
            .unwrap_or_else(|| {
                members_list
                    .first()
                    .map(|m| member_str(m, "bin_property_type"))
                    .unwrap_or_default()
            });
        let ctype = if ctype.is_empty() { "f32".to_string() } else { ctype };
        out.push(format!("{}0\r\n", sp(sp_n + 2)));
        out.push(format!("{}}}\r\n", sp(sp_n + 1)));
        out.push(format!("{}values: list[{}] = {{\r\n", sp(sp_n + 1), ctype));
        out.push(format!("{}{}\r\n", sp(sp_n + 2), const_value));
        out.push(format!("{}}}\r\n", sp(sp_n + 1)));
        out.push(format!("{}}}\r\n", sp(sp_n)));
    }
    out
}

// ── _write_property ────────────────────────────────────────────────

fn write_property(prop: &JsonValue, sp_n: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let force_dynamics = name_of(prop) == "worldAcceleration";

    let mut const_vals: Vec<JsonValue> = Vec::new();
    let mut prob_x: Vec<JsonValue> = Vec::new();
    let mut prob_y: Vec<JsonValue> = Vec::new();
    let mut prob_z: Vec<JsonValue> = Vec::new();
    let mut prob_a: Vec<JsonValue> = Vec::new();
    let mut times_t: Vec<JsonValue> = Vec::new();
    let mut times_simple: Vec<JsonValue> = Vec::new();

    let members = members_of(prop);
    for member in &members {
        let ptype = member_str(member, "bin_property_name");
        if ptype == "constantValue" { const_vals.push(member.clone()); }
        if ptype.contains("probTable") {
            if ptype.contains('X') { prob_x.push(member.clone()); }
            else if ptype.contains('Y') { prob_y.push(member.clone()); }
            else if ptype.contains('Z') { prob_z.push(member.clone()); }
            else { prob_a.push(member.clone()); }
        }
        if ptype.contains("timesTable") && !ptype.contains("Simple") {
            times_t.push(member.clone());
        }
        if ptype.contains("timesSimpleTable") {
            times_simple.push(member.clone());
        }
    }

    if members.is_empty() {
        return out;
    }

    let structure = bg(&members[0]).get("structure").and_then(|v| v.as_str()).unwrap_or("").to_string();

    if structure == "ChildParticleProperty" {
        let cv = get_value(&members[0]);
        let bgn = bg_name(&members[0]);
        let bgt = member_str(&members[0], "bin_group_type");
        let pn = member_str(&members[0], "bin_property_name");
        let pt = member_str(&members[0], "bin_property_type");
        out.push(format!("{}{}: {} {{\r\n", sp(sp_n), bgn, bgt));
        out.push(format!("{}childrenIdentifiers: list[embed] = {{\r\n", sp(sp_n + 1)));
        out.push(format!("{}VfxChildIdentifier {{\r\n", sp(sp_n + 2)));
        out.push(format!("{}{}: {} = {}\r\n", sp(sp_n + 3), pn, pt, cv));
        out.push(format!("{}}}\r\n", sp(sp_n + 2)));
        out.push(format!("{}}}\r\n", sp(sp_n + 1)));
        out.push(format!("{}}}\r\n", sp(sp_n)));
    } else if structure == "ColorTypeProperty" {
        if let Some(JsonValue::Array(cv)) = members[0].get("value") {
            if cv.len() >= 2 {
                let dv = members[0].get("default_value");
                // Python `cv[1] != dv` — needs permissive int/float
                // equality (0.0 == 0). serde_json::Value's strict
                // PartialEq would say `0.0 != 0` and emit a spurious
                // line.
                let same = match dv {
                    Some(d) => python_eq(d, &cv[1]),
                    None => false,
                };
                if !same {
                    let pn_raw = member_str(&members[0], "bin_property_name");
                    let pn = if pn_raw.is_empty() { name_of(prop) } else { pn_raw };
                    let bgt = member_str(&members[0], "bin_group_type");
                    let axis = cv[0].as_str().unwrap_or("");
                    out.push(format!("{}{}{}: {} = {}\r\n", sp(sp_n), pn, axis, bgt, fmt_num(&cv[1])));
                }
            }
        }
    } else if structure == "MultConstantValueProperty" {
        let bgt = member_str(&members[0], "bin_group_type");
        out.push(format!("{}{}: {} {{\r\n", sp(sp_n), name_of(prop), bgt));
        let (_, cv_lines) = write_constant_value(prop, sp_n + 1, true, false);
        out.extend(cv_lines);
        out.push(format!("{}}}\r\n", sp(sp_n)));
    } else if structure == "SimpleProperty" {
        let cv = get_value(&members[0]);
        let dv_str = match members[0].get("default_value") {
            Some(v) if !v.is_null() => fmt_num(v),
            _ => String::new(),
        };
        if cv != dv_str {
            let pn_raw = member_str(&members[0], "bin_property_name");
            let pn = if pn_raw.is_empty() { name_of(prop) } else { pn_raw };
            let bgt = member_str(&members[0], "bin_group_type");
            out.push(format!("{}{}: {} = {}\r\n", sp(sp_n), pn, bgt, cv));
        }
    } else if structure == "SimpleObjectProperty" {
        let cv_raw = members[0].get("value");
        let dv = members[0].get("default_value");
        // Outer wrapper comparison uses Python-`str()` semantics —
        // preserves `0.0` vs `0` distinction. The inner value
        // comparison inside `_write_constant_value` keeps using the
        // normalised `fmt_num` (matches Python's `_get_value`), so
        // we still elide the inner value when whole floats compare
        // equal to int defaults. Result: matches Python's quirky
        // "empty wrapper block" output for `value=0.0, default=0`.
        let cv_str_for_cmp = match cv_raw {
            Some(v) => python_str(v),
            None => "None".to_string(),
        };
        let dv_str_for_cmp = match dv {
            Some(v) => python_str(v),
            None => "None".to_string(),
        };
        if cv_str_for_cmp != dv_str_for_cmp {
            let bgt = member_str(&members[0], "bin_group_type");
            let is_str_array = member_str(&members[0], "troybin_type") == "STRINGS_NO_PATH";
            let m0_bg_name = bg_name(&members[0]);

            if is_str_array {
                if let Some(JsonValue::Array(arr)) = cv_raw {
                    out.push(format!("{}{}: {} = {{\r\n", sp(sp_n), name_of(prop), bgt));
                    for item in arr {
                        let s = item.as_str().unwrap_or("").to_string();
                        out.push(format!("{}\"{}\"\r\n", sp(sp_n + 1), s));
                    }
                    out.push(format!("{}}}\r\n", sp(sp_n)));
                }
            } else if m0_bg_name == "emitRotationAxes" {
                out.push(format!("{}{}: {} = {{\r\n", sp(sp_n), name_of(prop), bgt));
                for m in &members {
                    if let Some(JsonValue::Array(v)) = m.get("value") {
                        if v.len() >= 3 {
                            out.push(format!(
                                "{}{{ {}, {}, {} }}\r\n",
                                sp(sp_n + 1),
                                fmt_num(&v[0]), fmt_num(&v[1]), fmt_num(&v[2])
                            ));
                        }
                    }
                }
                out.push(format!("{}}}\r\n", sp(sp_n)));
            } else {
                out.push(format!("{}{}: {} = {{\r\n", sp(sp_n), name_of(prop), bgt));
                let (_, cv_lines) = write_constant_value(prop, sp_n + 1, true, true);
                out.extend(cv_lines);
                out.push(format!("{}}}\r\n", sp(sp_n)));
            }
        }
    } else if structure == "SimpleObjectVariableProperty" {
        let const_list = JsonValue::Array(const_vals.clone());
        let (cv_const, cv_lines) = write_constant_value(&const_list, sp_n + 1, false, false);

        let has_dynamics = !prob_x.is_empty()
            || !prob_y.is_empty()
            || !prob_z.is_empty()
            || !prob_a.is_empty()
            || !times_t.is_empty()
            || !times_simple.is_empty()
            || force_dynamics;

        if !cv_lines.is_empty() || has_dynamics {
            let mut bgt = member_str(&members[0], "bin_group_type");
            if let Some(c) = const_vals.first() {
                let v = member_str(c, "bin_group_type");
                if !v.is_empty() { bgt = v; }
            }
            if bgt.starts_with("pointer =") {
                let pt = bg(&members[0]).get("propertyType").and_then(|v| v.as_str()).unwrap_or("ValueVector3").to_string();
                bgt = if pt.is_empty() { "embed = ValueVector3".into() } else { format!("embed = {pt}") };
            }
            out.push(format!("{}{}: {} {{\r\n", sp(sp_n), name_of(prop), bgt));
            out.extend(cv_lines);
            if has_dynamics {
                out.extend(write_dynamics(
                    &cv_const, prop,
                    &prob_x, &prob_y, &prob_z, &prob_a,
                    sp_n + 1, &times_t, &times_simple, true,
                ));
            }
            out.push(format!("{}}}\r\n", sp(sp_n)));
        }
    } else if structure == "ShapeRotationAnglesProperty" {
        let bgt = member_str(&members[0], "bin_group_type");
        out.push(format!("{}{}: {} {{\r\n", sp(sp_n), name_of(prop), bgt));

        let mut times_x: Vec<JsonValue> = Vec::new();
        let mut times_y: Vec<JsonValue> = Vec::new();
        for t in &times_t {
            let tn = member_str(t, "troybin_name");
            if tn.contains("e-rotation1") { times_x.push(t.clone()); }
            else if tn.contains("e-rotation2") { times_y.push(t.clone()); }
        }

        // X rotation block
        let const_x = const_vals.iter().find(|c| {
            member_str(c, "troybin_name").contains("e-rotation1")
        }).cloned();
        let prob_x_rot: Vec<JsonValue> = prob_x.iter().filter(|p| {
            member_str(p, "troybin_name").contains("e-rotation1")
        }).cloned().collect();
        if !prob_x_rot.is_empty() || !times_x.is_empty() || const_x.is_some() {
            out.push(format!("{}ValueFloat {{\r\n", sp(sp_n + 1)));
            if let Some(c) = &const_x {
                out.push(format!("{}constantValue: f32 = {}\r\n", sp(sp_n + 2), get_value(c)));
            }
            if !prob_x_rot.is_empty() || !times_x.is_empty() {
                let const_value = const_x.as_ref().map(get_value).unwrap_or_else(|| "0".into());
                let inner_prop = serde_json::json!({
                    "members": match &const_x { Some(c) => vec![c.clone()], None => members.clone() }
                });
                out.extend(write_dynamics(
                    &const_value, &inner_prop,
                    &prob_x_rot, &[], &[], &[],
                    sp_n + 2, &times_x, &[], true,
                ));
            }
            out.push(format!("{}}}\r\n", sp(sp_n + 1)));
        }

        // Y rotation block
        let const_y = const_vals.iter().find(|c| {
            member_str(c, "troybin_name").contains("e-rotation2")
        }).cloned();
        let prob_y_rot: Vec<JsonValue> = prob_y.iter().filter(|p| {
            member_str(p, "troybin_name").contains("e-rotation2")
        }).cloned().collect();
        if !prob_y_rot.is_empty() || !times_y.is_empty() || const_y.is_some() {
            out.push(format!("{}ValueFloat {{\r\n", sp(sp_n + 1)));
            if let Some(c) = &const_y {
                out.push(format!("{}constantValue: f32 = {}\r\n", sp(sp_n + 2), get_value(c)));
            }
            if !prob_y_rot.is_empty() || !times_y.is_empty() {
                let const_value = const_y.as_ref().map(get_value).unwrap_or_else(|| "0".into());
                let inner_prop = serde_json::json!({
                    "members": match &const_y { Some(c) => vec![c.clone()], None => members.clone() }
                });
                out.extend(write_dynamics(
                    &const_value, &inner_prop,
                    &prob_y_rot, &[], &[], &[],
                    sp_n + 2, &times_y, &[], true,
                ));
            }
            out.push(format!("{}}}\r\n", sp(sp_n + 1)));
        }

        out.push(format!("{}}}\r\n", sp(sp_n)));
    }

    out
}

// ── Top-level emitter writer ───────────────────────────────────────

fn write_emitters(emitter_list: &[JsonValue], type_string: &str, spacing: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    out.push(format!("{}{}: list[pointer] = {{\r\n", sp(spacing + 1), type_string));

    for emitter in emitter_list {
        let emitter_arr = match emitter {
            JsonValue::Array(a) => a.clone(),
            _ => continue,
        };
        let mut props_written: Vec<String> = Vec::new();

        for prop in &emitter_arr {
            let name = name_of(prop);

            if name == "shape" {
                let mut lines: Vec<String> = Vec::new();
                for member in members_of(prop) {
                    lines.extend(write_property(&member, spacing + 4));
                }
                if !lines.is_empty() {
                    props_written.push(format!("{}shape: embed = VfxShape {{\r\n", sp(spacing + 3)));
                    props_written.extend(lines);
                    props_written.push(format!("{}}}\r\n", sp(spacing + 3)));
                }
            } else if name == "primitive" {
                // Skip the standalone primitive entry — the
                // primitive* block below emits the real primitive.
            } else if name.contains("primitive") && name != "primitiveNone" {
                match name.as_str() {
                    "primitiveArbitraryQuad" => {
                        props_written.push(format!(
                            "{}primitive: pointer = VfxPrimitiveArbitraryQuad {{}}\r\n",
                            sp(spacing + 3)
                        ));
                    }
                    "primitiveRay" => {
                        props_written.push(format!(
                            "{}primitive: pointer = VfxPrimitiveRay {{}}\r\n",
                            sp(spacing + 3)
                        ));
                    }
                    "primitiveBeam" => {
                        props_written.push(format!(
                            "{}primitive: pointer = VfxPrimitiveBeam {{\r\n",
                            sp(spacing + 3)
                        ));
                        let mesh_e: Vec<JsonValue> = members_of(prop).into_iter()
                            .filter(|m| name_of(m) == "mMesh").collect();
                        let beam_e: Vec<JsonValue> = members_of(prop).into_iter()
                            .filter(|m| name_of(m) != "mMesh").collect();
                        if !mesh_e.is_empty() {
                            props_written.push(format!("{}mMesh: embed = VfxMeshDefinitionData {{\r\n", sp(spacing + 4)));
                            for m in &mesh_e {
                                props_written.extend(write_property(m, spacing + 5));
                            }
                            props_written.push(format!("{}}}\r\n", sp(spacing + 4)));
                        }
                        if !beam_e.is_empty() {
                            props_written.push(format!("{}mBeam: embed = VfxBeamDefinitionData {{\r\n", sp(spacing + 4)));
                            for m in &beam_e {
                                props_written.extend(write_property(m, spacing + 5));
                            }
                            props_written.push(format!("{}}}\r\n", sp(spacing + 4)));
                        }
                        props_written.push(format!("{}}}\r\n", sp(spacing + 3)));
                    }
                    other => {
                        let (vfx_cls, sub_key, sub_cls) = match other {
                            "primitiveArbitraryTrail" => (Some("VfxPrimitiveArbitraryTrail"), Some("mTrail"), Some("VfxTrailDefinitionData")),
                            "primitiveMesh" => (Some("VfxPrimitiveMesh"), Some("mMesh"), Some("VfxMeshDefinitionData")),
                            "primitiveAttachedMesh" => (Some("VfxPrimitiveAttachedMesh"), Some("mMesh"), Some("VfxMeshDefinitionData")),
                            "primitiveTrail" => (Some("VfxPrimitiveCameraTrail"), Some("mTrail"), Some("VfxTrailDefinitionData")),
                            "primitivePlanarProjection" => (Some("VfxPrimitivePlanarProjection"), Some("mProjection"), Some("VfxProjectionDefinitionData")),
                            _ => (None, None, None),
                        };
                        if let (Some(cls), Some(sk), Some(sc)) = (vfx_cls, sub_key, sub_cls) {
                            props_written.push(format!("{}primitive: pointer = {} {{\r\n", sp(spacing + 3), cls));
                            props_written.push(format!("{}{}: embed = {} {{\r\n", sp(spacing + 4), sk, sc));
                            for member in members_of(prop) {
                                props_written.extend(write_property(&member, spacing + 5));
                            }
                            props_written.push(format!("{}}}\r\n", sp(spacing + 4)));
                            props_written.push(format!("{}}}\r\n", sp(spacing + 3)));
                        }
                    }
                }
            } else if name == "distortionDefinition" {
                props_written.push(format!("{}distortionDefinition: pointer = VfxDistortionDefinitionData {{\r\n", sp(spacing + 3)));
                for member in members_of(prop) {
                    props_written.extend(write_property(&member, spacing + 4));
                }
                props_written.push(format!("{}}}\r\n", sp(spacing + 3)));
            } else if name == "fieldCollectionDefinition" {
                let field_type_map = [
                    ("fieldAccelerationDefinitions", "Acceleration"),
                    ("fieldAttractionDefinitions", "Attraction"),
                    ("fieldDragDefinitions", "Drag"),
                    ("fieldNoiseDefinitions", "Noise"),
                    ("fieldOrbitalDefinitions", "Orbital"),
                ];
                let mut lines: Vec<String> = Vec::new();
                for member in members_of(prop) {
                    let mname = name_of(&member);
                    let ft = field_type_map.iter().find(|(k, _)| *k == mname.as_str()).map(|(_, v)| *v).unwrap_or("");
                    if !ft.is_empty() {
                        lines.push(format!("{}field{}Definitions: list[embed] = {{\r\n", sp(spacing + 4), ft));
                        for def_group in members_of(&member) {
                            lines.push(format!("{}VfxField{}DefinitionData {{\r\n", sp(spacing + 5), ft));
                            match &def_group {
                                JsonValue::Array(arr) => {
                                    for memb in arr {
                                        lines.extend(write_property(memb, spacing + 6));
                                    }
                                }
                                JsonValue::Object(_) => {
                                    lines.extend(write_property(&def_group, spacing + 6));
                                }
                                _ => {}
                            }
                            lines.push(format!("{}}}\r\n", sp(spacing + 5)));
                        }
                        lines.push(format!("{}}}\r\n", sp(spacing + 4)));
                    }
                }
                if !lines.is_empty() {
                    props_written.push(format!("{}fieldCollectionDefinition: pointer = VfxFieldCollectionDefinitionData {{\r\n", sp(spacing + 3)));
                    props_written.extend(lines);
                    props_written.push(format!("{}}}\r\n", sp(spacing + 3)));
                }
            } else if name == "materialOverrideDefinitions" {
                let mut lines: Vec<String> = Vec::new();
                for member_group in members_of(prop) {
                    let mm = if let JsonValue::Object(_) = &member_group {
                        members_of(&member_group)
                    } else if let JsonValue::Array(arr) = &member_group {
                        arr.clone()
                    } else {
                        Vec::new()
                    };
                    lines.push(format!("{}VfxMaterialOverrideDefinitionData {{\r\n", sp(spacing + 4)));
                    for memb in &mm {
                        match memb {
                            JsonValue::Array(inner) => {
                                for m in inner {
                                    lines.extend(write_property(m, spacing + 5));
                                }
                            }
                            _ => lines.extend(write_property(memb, spacing + 5)),
                        }
                    }
                    lines.push(format!("{}}}\r\n", sp(spacing + 4)));
                }
                if !lines.is_empty() {
                    props_written.push(format!("{}MaterialOverrideDefinitions: list[embed] = {{\r\n", sp(spacing + 3)));
                    props_written.extend(lines);
                    props_written.push(format!("{}}}\r\n", sp(spacing + 3)));
                }
            } else if name == "textureMult" {
                props_written.push(format!("{}textureMult: pointer = VfxTextureMultDefinitionData {{\r\n", sp(spacing + 3)));
                for member in members_of(prop) {
                    props_written.extend(write_property(&member, spacing + 4));
                }
                props_written.push(format!("{}}}\r\n", sp(spacing + 3)));
            } else if name == "0xbc022424" {
                props_written.push(format!("{}LegacySimple: pointer = VfxEmitterLegacySimple {{\r\n", sp(spacing + 3)));
                for member in members_of(prop) {
                    props_written.extend(write_property(&member, spacing + 4));
                }
                props_written.push(format!("{}}}\r\n", sp(spacing + 3)));
            } else {
                props_written.extend(write_property(prop, spacing + 3));
            }
        }

        if !props_written.is_empty() {
            out.push(format!("{}VfxEmitterDefinitionData {{\r\n", sp(spacing + 2)));
            out.extend(props_written);
            out.push(format!("{}}}\r\n", sp(spacing + 2)));
        }
    }

    out.push(format!("{}}}\r\n", sp(spacing + 1)));
    out
}

// ── Main entry point ───────────────────────────────────────────────

pub fn write_bin(bin_data: &BinData, default_file_path: &str) -> String {
    let spacing = 1usize;
    let mut final_text = String::new();
    final_text.push_str("#PROP_text\r\n");
    final_text.push_str("type: string = \"PROP\"\r\n");
    final_text.push_str("version: u32 = 3\r\n");
    final_text.push_str("linked: list[string] = {}\r\n");
    final_text.push_str("entries: map[hash,embed] = {\r\n");
    let path_prefix = if default_file_path.is_empty() { String::new() } else { format!("{default_file_path}/") };
    final_text.push_str(&format!(
        "{}\"{}{}\" = VfxSystemDefinitionData {{\r\n",
        sp(spacing), path_prefix, bin_data.name
    ));

    if !bin_data.complex_emitters.is_empty() {
        for line in write_emitters(&bin_data.complex_emitters, "complexEmitterDefinitionData", spacing) {
            final_text.push_str(&line);
        }
    }
    if !bin_data.simple_emitters.is_empty() {
        for line in write_emitters(&bin_data.simple_emitters, "simpleEmitterDefinitionData", spacing) {
            final_text.push_str(&line);
        }
    }
    for sys_prop in &bin_data.system {
        for line in write_property(sys_prop, spacing + 1) {
            final_text.push_str(&line);
        }
    }
    final_text.push_str(&format!("{}}}\r\n", sp(spacing)));
    final_text.push_str("}\r\n");

    // (The Python reference appends a free-text "Troygrade was
    // unable to translate the following properties" trailer here.
    // Jade is its own converter so we drop that — the BIN structure
    // ends at the closing brace, and `convert_troybin_to_bin_path`
    // no longer needs to strip a trailer before compiling.)

    final_text
}
