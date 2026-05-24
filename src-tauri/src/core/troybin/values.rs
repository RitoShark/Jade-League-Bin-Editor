//! Stage 3 backing data: `values.json` loader.
//!
//! `values.json` is the troybin → ritobin property mapping table the
//! original tool ships with (~900 entries across 5 namespaces, ~132
//! group definitions). It's embedded at compile time via `include_str!`
//! and parsed once on first use into a flat in-memory structure.
//!
//! Port of `_load_values` in `converter/read_troybin.py`. Each "slim"
//! entry from the JSON file gets expanded — its `bg` group-id is
//! resolved to a full `BinGroup`, and any group-id strings inside
//! `sv` arrays are likewise resolved.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value as JsonValue;

const VALUES_JSON: &str = include_str!("values.json");

/// One BIN group definition — describes the structure / placement of a
/// resolved bin property. `members` is a special marker list; the
/// Python tool inserts `"__has_members__"` when `hasMembers` is true
/// and the original JSON omits the field. Used by stages 4+5 to know
/// whether to wrap the property's value into a sub-container.
#[derive(Debug, Clone)]
pub struct BinGroup {
    pub name: String,
    pub structure: String,
    /// `order` is mostly integer-valued but some groups (e.g. `g11`)
    /// use fractional orderings like `50.3` to slot between integer
    /// values. Stored as f64 to handle both.
    pub order: f64,
    pub property_type: String,
    pub has_members: bool,
    pub members: Vec<String>,
    /// Some groups carry a `parent` field that's either a single
    /// nested group object or a list of them. We don't structurally
    /// model this — just preserve it verbatim as JSON so stages 4+5
    /// can read whatever they need. `None` when the field is absent.
    pub parent: Option<serde_json::Value>,
}

impl Default for BinGroup {
    fn default() -> Self {
        Self {
            name: String::new(),
            structure: String::new(),
            order: 0.0,
            property_type: String::new(),
            has_members: false,
            members: Vec::new(),
            parent: None,
        }
    }
}

/// One sv-array element — either a literal token (a format-type tag
/// like `"TWO_DOUBLE"` or a structural tag like `"vec2"`) or a resolved
/// group object. The Python tool replaces group-id strings with their
/// resolved group dict; we mirror that.
#[derive(Debug, Clone)]
pub enum SvItem {
    Text(String),
    Group(BinGroup),
}

/// One mapping entry — port of the expanded form `read_troybin.py`
/// produces from each slim JSON record.
#[derive(Debug, Clone, Default)]
pub struct ValueEntry {
    pub troybin_name: String,
    pub troybin_type: String,
    pub bin_group: BinGroup,
    pub bin_group_type: String,
    pub bin_property_name: String,
    pub bin_property_type: String,
    pub default_value: Option<DefaultValue>,
    pub simple_value: Vec<SvItem>,
}

/// `dv` field is either a JSON int or a JSON string in the source
/// file. Keep both shapes so stage 4 can compare against typed values
/// without losing the distinction.
#[derive(Debug, Clone)]
pub enum DefaultValue {
    Int(i64),
    Str(String),
}

/// All five namespace lists kept side-by-side so the lookup in
/// `read_troybin.rs` can dispatch by property-name prefix.
#[derive(Debug, Clone, Default)]
pub struct ValuesTable {
    pub e_values: Vec<ValueEntry>,
    pub p_values: Vec<ValueEntry>,
    pub f_values: Vec<ValueEntry>,
    pub system_values: Vec<ValueEntry>,
    pub others: Vec<ValueEntry>,
}

/// Singleton cache — parsing the 265 KB JSON file once at startup is
/// enough; nothing in the pipeline mutates the table. Returns a
/// `Result` so a future schema mismatch surfaces as a recoverable
/// error in the Tauri command path instead of crashing the whole app
/// (which is what a panic inside a Tauri command handler does on
/// Windows — non-unwinding because it gets caught inside WebView2's
/// foreign frame).
static VALUES: OnceLock<Result<ValuesTable, String>> = OnceLock::new();

pub fn try_values() -> Result<&'static ValuesTable, String> {
    let cached = VALUES.get_or_init(load);
    cached.as_ref().map_err(|e| e.clone())
}

/// Convenience accessor for callers that don't want to plumb a
/// `Result` through — panics with a clear message if the embedded
/// JSON ever fails to parse. Use only from places where a panic is
/// actually fatal (tests, startup self-check); never from a Tauri
/// command handler.
#[allow(dead_code)]
pub fn values() -> &'static ValuesTable {
    match try_values() {
        Ok(v) => v,
        Err(e) => panic!("troybin: failed to parse embedded values.json: {e}"),
    }
}

// ── Internal loader ────────────────────────────────────────────────

#[derive(Deserialize)]
struct RawRoot {
    groups: HashMap<String, RawGroup>,
    #[serde(rename = "eValues", default)]
    e_values: Vec<RawEntry>,
    #[serde(rename = "pValues", default)]
    p_values: Vec<RawEntry>,
    #[serde(rename = "fValues", default)]
    f_values: Vec<RawEntry>,
    #[serde(rename = "systemValues", default)]
    system_values: Vec<RawEntry>,
    #[serde(default)]
    others: Vec<RawEntry>,
}

#[derive(Deserialize, Clone, Default)]
struct RawGroup {
    #[serde(default)]
    name: String,
    #[serde(default)]
    structure: String,
    /// `order` can be an int or a float in the source data.
    #[serde(default)]
    order: f64,
    #[serde(default, rename = "propertyType")]
    property_type: String,
    #[serde(default, rename = "hasMembers")]
    has_members: bool,
    /// Groups in `values.json` don't actually carry a `members` field
    /// — the Python tool synthesises it from `hasMembers` at resolve
    /// time (and `["__has_members__"]` is the sentinel for "yes
    /// there are members, content TBD by callers"). Kept as
    /// `Option<Vec<String>>` defensively in case future entries
    /// include one.
    #[serde(default)]
    members: Option<Vec<String>>,
    /// `parent` is either a nested group object or an array of them.
    /// We keep the raw JSON value so we don't constrain its shape.
    #[serde(default)]
    parent: Option<serde_json::Value>,
}

#[derive(Deserialize, Clone, Default)]
struct RawEntry {
    #[serde(default)]
    tn: String,
    #[serde(default)]
    tt: String,
    /// `bg` (group ID) is mostly a string, but at least one entry in
    /// values.json (`GroupPartType`) has `"bg": null` — treat it the
    /// same as an empty string (which `resolve_group` already returns
    /// a default for). All other string fields below are typed as
    /// plain `String` with serde-default because no null shows up in
    /// them in the current dataset.
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    bg: String,
    #[serde(default)]
    bgt: String,
    #[serde(default)]
    bpn: String,
    #[serde(default)]
    bpt: String,
    #[serde(default)]
    dv: Option<JsonValue>,
    #[serde(default)]
    sv: Option<Vec<JsonValue>>,
}

/// Treat JSON `null` as an empty string. Used for fields where the
/// data sometimes stores `null` to mean "not set" rather than an
/// empty string or omitting the field.
fn deserialize_nullable_string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt = Option::<String>::deserialize(d)?;
    Ok(opt.unwrap_or_default())
}

fn load() -> Result<ValuesTable, String> {
    let root: RawRoot = serde_json::from_str(VALUES_JSON)
        .map_err(|e| format!("{}", e))?;

    let resolve = |gid: &str, groups: &HashMap<String, RawGroup>| -> BinGroup {
        if gid.is_empty() { return BinGroup::default(); }
        match groups.get(gid) {
            None => BinGroup::default(),
            Some(g) => {
                // Restore members per the Python rule: `hasMembers` true
                // and missing/empty `members` becomes `["__has_members__"]`.
                let members = if g.has_members {
                    match &g.members {
                        Some(m) if !m.is_empty() => m.clone(),
                        _ => vec!["__has_members__".to_string()],
                    }
                } else {
                    g.members.clone().unwrap_or_default()
                };
                BinGroup {
                    name: g.name.clone(),
                    structure: g.structure.clone(),
                    order: g.order,
                    property_type: g.property_type.clone(),
                    has_members: g.has_members,
                    members,
                    parent: g.parent.clone(),
                }
            }
        }
    };

    let expand = |e: RawEntry, groups: &HashMap<String, RawGroup>| -> ValueEntry {
        let dv = e.dv.and_then(|v| match v {
            JsonValue::Number(n) => n.as_i64().map(DefaultValue::Int),
            JsonValue::String(s) => Some(DefaultValue::Str(s)),
            _ => None,
        });
        let sv = e
            .sv
            .unwrap_or_default()
            .into_iter()
            .map(|item| match item {
                JsonValue::String(s) => {
                    if groups.contains_key(&s) {
                        SvItem::Group(resolve(&s, groups))
                    } else {
                        SvItem::Text(s)
                    }
                }
                other => SvItem::Text(other.to_string()),
            })
            .collect::<Vec<_>>();
        ValueEntry {
            troybin_name: e.tn,
            troybin_type: e.tt,
            bin_group: resolve(&e.bg, groups),
            bin_group_type: e.bgt,
            bin_property_name: e.bpn,
            bin_property_type: e.bpt,
            default_value: dv,
            simple_value: sv,
        }
    };

    Ok(ValuesTable {
        e_values: root.e_values.into_iter().map(|e| expand(e, &root.groups)).collect(),
        p_values: root.p_values.into_iter().map(|e| expand(e, &root.groups)).collect(),
        f_values: root.f_values.into_iter().map(|e| expand(e, &root.groups)).collect(),
        system_values: root.system_values.into_iter().map(|e| expand(e, &root.groups)).collect(),
        others: root.others.into_iter().map(|e| expand(e, &root.groups)).collect(),
    })
}
