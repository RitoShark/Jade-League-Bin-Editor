//! Stage 3 helper: value-shape coercion driven by `troybinType` tags.
//!
//! Direct port of `format_value.py`. Each `troybinType` string in
//! `values.json` selects a coercion routine that turns the raw INI
//! property text (everything after the `=`) into a typed
//! [`FormattedValue`]. Unsupported types or shape mismatches produce
//! [`FormattedValue::Invalid`].

/// One stage-3 output value. The Python original is dynamically
/// typed; this enum captures every concrete shape its `format_value`
/// can return. `Invalid` is the explicit "the INI text didn't fit the
/// expected shape" marker and is treated like `INVALID_VALUE` in the
/// reference.
#[derive(Debug, Clone, PartialEq)]
pub enum FormattedValue {
    Number(f64),
    Numbers(Vec<f64>),
    Int(i64),
    /// Homogeneous int-typed list. Python's `update_emitters`
    /// sometimes builds `[val, val]` / `[val, val, val]` from a
    /// scalar `int` value, preserving the int type through the JSON
    /// dump. Stored separately from `Numbers` so we don't print `1.0`
    /// where Python prints `1`.
    IntList(Vec<i64>),
    Bool(bool),
    /// `String` here is the verbatim text the formatter chose to
    /// expose — `STRING_PATH` returns the original wrapped in quotes,
    /// `STRING_NO_EXT` strips `.troy`, etc. Stage 5 emits this
    /// straight to ritobin text where appropriate.
    Str(String),
    Strings(Vec<String>),
    /// `TWO_DOUBLE_TO_XYZ` returns an `(axis_label, value)` pair like
    /// `("Y", 1.0)`.
    AxisValue(String, f64),
    Invalid,
}

// ── Public entry points ────────────────────────────────────────────

/// Split an INI text block into trimmed-non-empty lines. The Python
/// `format_input` uses `text.replace("\r\n","\n").split("\n")` and
/// filters by `r.strip()`; we mirror that. Lines themselves are NOT
/// stripped of surrounding whitespace — only the empty-check is — to
/// preserve the section/property text exactly as `get_structure_data`
/// expects.
pub fn format_input(text: &str) -> Vec<String> {
    let cleaned = text.replace("\r\n", "\n");
    cleaned
        .split('\n')
        .filter(|r| !r.trim().is_empty())
        .map(|r| r.to_string())
        .collect()
}

/// Section-structure scan. Returns the absolute indices of every
/// `[Section]` header line plus a separate index for the
/// `[UNKNOWN_HASHES]` header so the caller can split rows into
/// sections.
#[derive(Debug, Clone, Default)]
pub struct StructureData {
    pub entry_amount: usize,
    pub entry_start_indices: Vec<usize>,
    pub system_index: usize,
    pub unknown_index: i64,
}

pub fn get_structure_data(rows: &[String]) -> StructureData {
    let mut out = StructureData::default();
    out.unknown_index = -1;
    for (i, row) in rows.iter().enumerate() {
        if row.starts_with('[') {
            out.entry_start_indices.push(i);
            out.entry_amount += 1;
            if row == "[System]" {
                out.system_index = i;
            }
        }
        // Match the Python's two-pronged check — exact tag, or any
        // row containing UNKNOWN_HASH. Only record the first hit.
        if (row == "[UNKNOWN_HASHES]" || row.contains("UNKNOWN_HASH")) && out.unknown_index == -1
        {
            // Only push if not already counted by the `[` branch above
            // (the exact-tag form starts with `[` so it's already there).
            let already_added = out
                .entry_start_indices
                .last()
                .copied()
                .map(|last| last == i)
                .unwrap_or(false);
            if !already_added {
                out.entry_start_indices.push(i);
                out.entry_amount += 1;
            }
            out.unknown_index = i as i64;
        }
    }
    out
}

/// Convert a property's raw text value (the right-hand side of the
/// INI `name=...` line) into a typed [`FormattedValue`] using
/// `troybin_type` as the discriminator.
///
/// `default_assets_path` — prepended to `STRING_PATH` values that
/// aren't already prefixed by `DATA/` or `ASSETS/`. The reference uses
/// `"Assets/Particles"`.
///
/// `update_file_types` — when true, `STRING_PATH` rewrites `.tga` →
/// `.dds`. Matches the Python tool's `update_file_types` flag.
pub fn format_value(
    values_str: &str,
    typ: &str,
    default_assets_path: &str,
    update_file_types: bool,
) -> FormattedValue {
    match typ {
        "ONE_DOUBLE" => match parse_f64(values_str) {
            Some(v) if !v.is_nan() => FormattedValue::Number(v),
            _ => FormattedValue::Invalid,
        },
        "TWO_DOUBLE" => exact_n_doubles(values_str, 2),
        "THREE_DOUBLE" => exact_n_doubles(values_str, 3),
        "FOUR_DOUBLE" => exact_n_doubles(values_str, 4),
        "FIVE_DOUBLE" => {
            let nums = format_number(values_str);
            if nums.len() == 5 {
                FormattedValue::Numbers(nums)
            } else if nums.len() == 4 {
                let mut v = nums;
                v.push(1.0);
                FormattedValue::Numbers(v)
            } else {
                FormattedValue::Invalid
            }
        }
        "FIVE_DOUBLE_COLOR" => {
            let mut nums = format_number(values_str);
            if nums.len() != 5 {
                return FormattedValue::Invalid;
            }
            // If any of the colour channels are out of [0,1] the
            // reference assumes they're 0..255 and rescales the four
            // RGBA components — leaving the leading time/index
            // component intact.
            if nums[1..].iter().any(|v| *v > 1.0) {
                for v in nums.iter_mut().skip(1) {
                    *v = ((*v / 255.0) * 100.0).round_ties_even() / 100.0;
                }
            }
            FormattedValue::Numbers(nums)
        }
        "COLOR_DOUBLE" => {
            let mut nums = format_number(values_str);
            if nums.len() != 4 {
                return FormattedValue::Invalid;
            }
            if nums.iter().any(|v| *v > 1.0) {
                for v in nums.iter_mut() {
                    *v /= 255.0;
                }
            }
            FormattedValue::Numbers(nums)
        }
        "DOUBLE_TO_PRIMITIVE" => {
            // Stripped float forms like "3.0" map the same as "3".
            let clean = strip_float_zero(values_str.trim());
            FormattedValue::Str(match clean.as_str() {
                "0" | "9" | "10" | "11" => "primitiveNone".to_string(),
                "1" => "primitiveArbitraryQuad".to_string(),
                "2" => "primitiveRay".to_string(),
                "3" => "primitiveMesh".to_string(),
                "4" => "primitiveTrail".to_string(),
                "5" => "primitiveArbitraryTrail".to_string(),
                "6" => "primitiveBeam".to_string(),
                "7" => "primitivePlanarProjection".to_string(),
                "8" => "primitiveAttachedMesh".to_string(),
                _ => return FormattedValue::Invalid,
            })
        }
        "BOOLEAN/INT" => {
            let clean = strip_float_zero(values_str.trim());
            match clean.as_str() {
                "4" => FormattedValue::Int(4),
                "\"NotWhenHigh\"" | "3" => FormattedValue::Int(3),
                "\"High\"" | "\"clamp\"" | "2" => FormattedValue::Int(2),
                "\"Medium\"" | "true" | "1" => FormattedValue::Int(1),
                "\"Low\"" | "0" => FormattedValue::Int(0),
                _ => match parse_f64(&clean) {
                    Some(v) => FormattedValue::Int(v as i64),
                    None => FormattedValue::Invalid,
                },
            }
        }
        "INT/BOOLEAN" => {
            let clean = strip_float_zero(values_str.trim());
            match clean.as_str() {
                "1" | "true" => FormattedValue::Bool(true),
                "0" | "false" => FormattedValue::Bool(false),
                _ => FormattedValue::Invalid,
            }
        }
        "SET_ONE_DOUBLE" => {
            if values_str == "1" {
                FormattedValue::Int(2)
            } else {
                FormattedValue::Invalid
            }
        }
        "STRING_PATH" => {
            let clean = values_str.replace('"', "");
            let upper = clean.to_ascii_uppercase();
            let mut wrapped = if upper.starts_with("DATA/") || upper.starts_with("ASSETS/") {
                format!("\"{clean}\"")
            } else {
                format!("\"{default_assets_path}/{clean}\"")
            };
            if update_file_types {
                wrapped = wrapped.replace(".tga", ".dds");
            }
            FormattedValue::Str(wrapped)
        }
        "STRING_NO_EXT" => FormattedValue::Str(values_str.replace(".troy", "")),
        "STRING_NO_PATH" => FormattedValue::Str(values_str.to_string()),
        "STRINGS_NO_PATH" => FormattedValue::Strings(
            values_str
                .replace('"', "")
                .split_whitespace()
                .map(|s| s.to_string())
                .collect(),
        ),
        "TWO_DOUBLE_TO_ONE" => two_double_to_one(values_str),
        "TWO_DOUBLE_TO_XYZ" => two_double_to_xyz(values_str),
        "ENSURE_TWO_DOUBLE" => {
            let nums = format_number(values_str);
            match nums.len() {
                2 => FormattedValue::Numbers(nums),
                1 => FormattedValue::Numbers(vec![nums[0], nums[0]]),
                _ => FormattedValue::Invalid,
            }
        }
        "THREE_DOUBLE || ONE_DOUBLE" => three_double_or_one(values_str),
        "ONE_DOUBLE_255_TO_PERCENT" => match parse_f64(values_str) {
            Some(v) if !v.is_nan() => {
                FormattedValue::Number(((v / 255.0) * 100.0).round_ties_even() / 100.0)
            }
            _ => FormattedValue::Invalid,
        },
        _ => FormattedValue::Invalid,
    }
}

// ── Helpers ────────────────────────────────────────────────────────

fn exact_n_doubles(text: &str, n: usize) -> FormattedValue {
    let nums = format_number(text);
    if nums.len() == n {
        FormattedValue::Numbers(nums)
    } else {
        FormattedValue::Invalid
    }
}

/// Whitespace-separated list of floats. Tolerates trailing garbage by
/// stripping every byte except digits, dot, e/E, and +/- before the
/// retry parse (Python's `re.sub(r'[^\d.eE+-]', '', x)`).
pub fn format_number(values_str: &str) -> Vec<f64> {
    let clean = values_str.trim().trim_matches('"');
    let mut out: Vec<f64> = Vec::new();
    for piece in clean.split_whitespace() {
        if piece.is_empty() {
            continue;
        }
        if let Ok(v) = piece.parse::<f64>() {
            out.push(v);
            continue;
        }
        // Strip non-numeric chars (per Python's `re.sub`) and retry.
        let stripped: String = piece
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '.' || *c == 'e' || *c == 'E' || *c == '+' || *c == '-')
            .collect();
        if !stripped.is_empty() {
            if let Ok(v) = stripped.parse::<f64>() {
                out.push(v);
            }
        }
    }
    out
}

fn parse_f64(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok()
}

/// Match the Python pattern `if "." in clean: clean = str(int(float(clean)))`
/// — only when the value parses as a whole number. Used by several
/// branches to normalise `"4.0"` → `"4"` before matching the literal
/// dispatch table.
fn strip_float_zero(text: &str) -> String {
    if !text.contains('.') {
        return text.to_string();
    }
    match text.parse::<f64>() {
        Ok(v) if v == v.trunc() => format!("{}", v as i64),
        _ => text.to_string(),
    }
}

fn two_double_to_one(text: &str) -> FormattedValue {
    let clean = text.trim().trim_matches('"');
    let parts: Vec<&str> = clean.split_whitespace().collect();

    // Python's normalisation: any "1.0" → "1", "0.0" → "0".
    let norm_parts: Vec<String> = parts.iter().map(|p| strip_float_zero(p)).collect();
    let norm = norm_parts.join(" ");

    if clean == "1" || clean == "1.0" || norm == "1" {
        return FormattedValue::Int(1);
    }
    if !parts.is_empty() && (parts[0] == "1.0" || parts[0] == "1") {
        return FormattedValue::Int(1);
    }
    if parts.len() >= 2 && (parts[1] == "1.0" || parts[1] == "1") {
        return FormattedValue::Int(1);
    }
    if clean == "0" || clean == "0.0" {
        return FormattedValue::Int(0);
    }
    if parts.len() == 2 {
        return match parse_f64(parts[0]) {
            Some(v) => FormattedValue::Number(v),
            None => FormattedValue::Invalid,
        };
    }
    FormattedValue::Invalid
}

fn two_double_to_xyz(text: &str) -> FormattedValue {
    let trimmed = text.trim();
    if trimmed == "1" || trimmed == "1.0" {
        return FormattedValue::AxisValue("Y".to_string(), 1.0);
    }
    let parts: Vec<&str> = text.split_whitespace().collect();
    if parts.len() == 2 {
        let axis_val = match parse_f64(parts[0]) { Some(v) => v, None => return FormattedValue::Invalid };
        let val = match parse_f64(parts[1]) { Some(v) => v, None => return FormattedValue::Invalid };
        let axis = if axis_val == 0.0 { "X" } else if axis_val == 1.0 { "Y" } else { "Z" };
        return FormattedValue::AxisValue(axis.to_string(), val);
    }
    FormattedValue::Invalid
}

fn three_double_or_one(text: &str) -> FormattedValue {
    let trimmed = text.trim().trim_matches('"');
    // Strip trailing `[Drag]`-style annotations. Python uses
    // `re.sub(r'\[.*\]', '', s)` — a greedy match. We hand-roll it
    // since the rest of the formatter is regex-free.
    let stripped_owned = strip_bracketed(trimmed);
    let clean = stripped_owned.trim();
    let parts: Vec<&str> = clean.split_whitespace().collect();
    if parts.len() == 3 {
        let nums = format_number(clean);
        return if nums.len() == 3 {
            FormattedValue::Numbers(nums)
        } else {
            FormattedValue::Invalid
        };
    }
    match parse_f64(clean) {
        Some(v) if !v.is_nan() => FormattedValue::Number(v),
        _ => FormattedValue::Invalid,
    }
}

/// Drop everything between (and including) the first `[` and the last
/// `]` in the input. Mirrors the greedy `\[.*\]` regex used in the
/// Python reference's `THREE_DOUBLE || ONE_DOUBLE` branch.
fn strip_bracketed(s: &str) -> String {
    let Some(open) = s.find('[') else { return s.to_string(); };
    let Some(close) = s.rfind(']') else { return s.to_string(); };
    if close < open { return s.to_string(); }
    let mut out = String::with_capacity(s.len());
    out.push_str(&s[..open]);
    out.push_str(&s[close + 1..]);
    out
}
