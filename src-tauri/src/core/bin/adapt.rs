//! Lossless conversion between the LTK tree (`ltk_meta::Bin`) and the
//! Jade-native tree (`jade::types::Bin`).
//!
//! The app uses the Jade-native tree as the single canonical in-memory
//! representation for every bin operation that walks the property tree
//! (texture/animation/mesh preview, repath, asset scan). That keeps the
//! "Jade Custom" engine path entirely free of `ltk_meta` — under that
//! engine the bytes are parsed and written by Jade's own reader/writer
//! and never touch these adapters.
//!
//! When the "LTK Converter" engine is selected, bytes are parsed/written
//! by `ltk_meta` and bridged through here so the walkers still see a
//! Jade tree. Both directions are exact inverses so a cross-engine
//! round-trip is lossless.

use indexmap::IndexMap;
use ltk_meta::property::values::{self, Container, Map as LtkMap, Optional, UnorderedContainer};
use ltk_meta::property::NoMeta;
use ltk_meta::{Bin as LtkBin, BinObject, PropertyKind as Kind, PropertyValueEnum as Lv};
use ltk_primitives::Color as LtkColor;
// ltk_meta's glam (0.27), separate from the mesh code's 0.29 copy. Must
// match exactly so the constructed vector/matrix types are ltk's.
use glam027::{Mat4, Vec2, Vec3, Vec4};

use super::jade::types::{Bin as JadeBin, BinField, BinType, BinValue as Jv, FNV1a, XXH64};

/// LTK property kind → Jade bin type.
fn kind_to_bt(k: Kind) -> BinType {
    match k {
        Kind::None => BinType::None,
        Kind::Bool => BinType::Bool,
        Kind::I8 => BinType::I8,
        Kind::U8 => BinType::U8,
        Kind::I16 => BinType::I16,
        Kind::U16 => BinType::U16,
        Kind::I32 => BinType::I32,
        Kind::U32 => BinType::U32,
        Kind::I64 => BinType::I64,
        Kind::U64 => BinType::U64,
        Kind::F32 => BinType::F32,
        Kind::Vector2 => BinType::Vec2,
        Kind::Vector3 => BinType::Vec3,
        Kind::Vector4 => BinType::Vec4,
        Kind::Matrix44 => BinType::Mtx44,
        Kind::Color => BinType::Rgba,
        Kind::String => BinType::String,
        Kind::Hash => BinType::Hash,
        Kind::WadChunkLink => BinType::File,
        Kind::Container => BinType::List,
        Kind::UnorderedContainer => BinType::List2,
        Kind::Struct => BinType::Pointer,
        Kind::Embedded => BinType::Embed,
        Kind::ObjectLink => BinType::Link,
        Kind::Optional => BinType::Option,
        Kind::Map => BinType::Map,
        Kind::BitBool => BinType::Flag,
    }
}

/// Jade bin type → LTK property kind.
fn bt_to_kind(t: BinType) -> Kind {
    match t {
        BinType::None => Kind::None,
        BinType::Bool => Kind::Bool,
        BinType::I8 => Kind::I8,
        BinType::U8 => Kind::U8,
        BinType::I16 => Kind::I16,
        BinType::U16 => Kind::U16,
        BinType::I32 => Kind::I32,
        BinType::U32 => Kind::U32,
        BinType::I64 => Kind::I64,
        BinType::U64 => Kind::U64,
        BinType::F32 => Kind::F32,
        BinType::Vec2 => Kind::Vector2,
        BinType::Vec3 => Kind::Vector3,
        BinType::Vec4 => Kind::Vector4,
        BinType::Mtx44 => Kind::Matrix44,
        BinType::Rgba => Kind::Color,
        BinType::String => Kind::String,
        BinType::Hash => Kind::Hash,
        BinType::File => Kind::WadChunkLink,
        BinType::List => Kind::Container,
        BinType::List2 => Kind::UnorderedContainer,
        BinType::Pointer => Kind::Struct,
        BinType::Embed => Kind::Embedded,
        BinType::Link => Kind::ObjectLink,
        BinType::Option => Kind::Optional,
        BinType::Map => Kind::Map,
        BinType::Flag => Kind::BitBool,
    }
}

// ───────────────────────────── LTK → Jade ──────────────────────────────

/// Convert a parsed `ltk_meta::Bin` into the canonical Jade tree.
pub fn ltk_to_jade(bin: &LtkBin) -> JadeBin {
    let mut out = JadeBin::new();
    out.sections.insert(
        "type".to_string(),
        Jv::String(if bin.is_override { "PTCH" } else { "PROP" }.to_string()),
    );
    out.sections.insert("version".to_string(), Jv::U32(bin.version));

    if !bin.dependencies.is_empty() {
        let items = bin.dependencies.iter().map(|d| Jv::String(d.clone())).collect();
        out.sections
            .insert("linked".to_string(), Jv::List { value_type: BinType::String, items });
    }

    let mut map_items = Vec::with_capacity(bin.objects.len());
    for (path_hash, obj) in &bin.objects {
        let fields = obj
            .properties
            .iter()
            .map(|(k, v)| BinField { key: FNV1a::new(*k), value: lv_to_jv(v) })
            .collect();
        map_items.push((
            Jv::Hash(FNV1a::new(*path_hash)),
            Jv::Embed { name: FNV1a::new(obj.class_hash), fields },
        ));
    }
    out.sections.insert(
        "entries".to_string(),
        Jv::Map { key_type: BinType::Hash, value_type: BinType::Embed, items: map_items },
    );
    out
}

fn props_to_fields(props: &IndexMap<u32, Lv>) -> Vec<BinField> {
    props
        .iter()
        .map(|(k, v)| BinField { key: FNV1a::new(*k), value: lv_to_jv(v) })
        .collect()
}

fn lv_to_jv(v: &Lv) -> Jv {
    match v {
        Lv::None(_) => Jv::None,
        Lv::Bool(x) => Jv::Bool(x.value),
        Lv::I8(x) => Jv::I8(x.value),
        Lv::U8(x) => Jv::U8(x.value),
        Lv::I16(x) => Jv::I16(x.value),
        Lv::U16(x) => Jv::U16(x.value),
        Lv::I32(x) => Jv::I32(x.value),
        Lv::U32(x) => Jv::U32(x.value),
        Lv::I64(x) => Jv::I64(x.value),
        Lv::U64(x) => Jv::U64(x.value),
        Lv::F32(x) => Jv::F32(x.value),
        Lv::Vector2(x) => Jv::Vec2(x.value.to_array()),
        Lv::Vector3(x) => Jv::Vec3(x.value.to_array()),
        Lv::Vector4(x) => Jv::Vec4(x.value.to_array()),
        Lv::Matrix44(x) => Jv::Mtx44(x.value.to_cols_array()),
        Lv::Color(x) => Jv::Rgba(x.value.r, x.value.g, x.value.b, x.value.a),
        Lv::String(x) => Jv::String(x.value.clone()),
        Lv::Hash(x) => Jv::Hash(FNV1a::new(x.value)),
        Lv::WadChunkLink(x) => Jv::File(XXH64::new(x.value)),
        Lv::ObjectLink(x) => Jv::Link(FNV1a::new(x.value)),
        Lv::BitBool(x) => Jv::Flag(x.value),
        Lv::Struct(s) => Jv::Pointer {
            name: FNV1a::new(s.class_hash),
            fields: props_to_fields(&s.properties),
        },
        Lv::Embedded(e) => Jv::Embed {
            name: FNV1a::new(e.0.class_hash),
            fields: props_to_fields(&e.0.properties),
        },
        Lv::Container(c) => {
            let value_type = kind_to_bt(c.item_kind());
            let items = c.clone().into_items().map(|i| lv_to_jv(&i)).collect();
            Jv::List { value_type, items }
        }
        Lv::UnorderedContainer(uc) => {
            let value_type = kind_to_bt(uc.0.item_kind());
            let items = uc.0.clone().into_items().map(|i| lv_to_jv(&i)).collect();
            Jv::List2 { value_type, items }
        }
        Lv::Optional(o) => {
            let value_type = kind_to_bt(o.item_kind());
            let (inner, _) = o.clone().into_parts();
            let items = inner.map(|i| lv_to_jv(&i)).into_iter().collect();
            Jv::Option { value_type, items }
        }
        Lv::Map(m) => {
            let key_type = kind_to_bt(m.key_kind());
            let value_type = kind_to_bt(m.value_kind());
            let items = m.entries().iter().map(|(k, v)| (lv_to_jv(k), lv_to_jv(v))).collect();
            Jv::Map { key_type, value_type, items }
        }
    }
}

// ───────────────────────────── Jade → LTK ──────────────────────────────

/// Convert the canonical Jade tree back into an `ltk_meta::Bin` for
/// serialization through the LTK writer.
pub fn jade_to_ltk(bin: &JadeBin) -> Result<LtkBin, String> {
    let mut out = LtkBin::default();

    if let Some(Jv::String(t)) = bin.sections.get("type") {
        out.is_override = t == "PTCH";
    }
    if let Some(Jv::U32(v)) = bin.sections.get("version") {
        out.version = *v;
    }
    if let Some(Jv::List { items, .. }) = bin.sections.get("linked") {
        for it in items {
            if let Jv::String(s) = it {
                out.dependencies.push(s.clone());
            }
        }
    }
    if let Some(Jv::Map { items, .. }) = bin.sections.get("entries") {
        for (key, val) in items {
            let path_hash = match key {
                Jv::Hash(h) => h.hash,
                _ => continue,
            };
            let (class_hash, fields) = match val {
                Jv::Embed { name, fields } => (name.hash, fields),
                Jv::Pointer { name, fields } => (name.hash, fields),
                _ => continue,
            };
            let mut obj = BinObject::new(path_hash, class_hash);
            obj.properties = fields_to_props(fields)?;
            out.objects.insert(path_hash, obj);
        }
    }
    Ok(out)
}

fn fields_to_props(fields: &[BinField]) -> Result<IndexMap<u32, Lv>, String> {
    let mut map = IndexMap::with_capacity(fields.len());
    for f in fields {
        map.insert(f.key.hash, jv_to_lv(&f.value)?);
    }
    Ok(map)
}

fn build_container(vt: BinType, items: &[Jv]) -> Result<Container, String> {
    if items.is_empty() {
        Container::empty(bt_to_kind(vt)).map_err(|e| format!("empty container: {e:?}"))
    } else {
        let pves: Vec<Lv> = items.iter().map(jv_to_lv).collect::<Result<_, _>>()?;
        Container::try_from(pves).map_err(|e| format!("container: {e:?}"))
    }
}

fn jv_to_lv(v: &Jv) -> Result<Lv, String> {
    Ok(match v {
        Jv::None => Lv::None(values::None::default()),
        Jv::Bool(x) => values::Bool::new(*x).into(),
        Jv::I8(x) => values::I8::new(*x).into(),
        Jv::U8(x) => values::U8::new(*x).into(),
        Jv::I16(x) => values::I16::new(*x).into(),
        Jv::U16(x) => values::U16::new(*x).into(),
        Jv::I32(x) => values::I32::new(*x).into(),
        Jv::U32(x) => values::U32::new(*x).into(),
        Jv::I64(x) => values::I64::new(*x).into(),
        Jv::U64(x) => values::U64::new(*x).into(),
        Jv::F32(x) => values::F32::new(*x).into(),
        Jv::Vec2(a) => values::Vector2::new(Vec2::from_array(*a)).into(),
        Jv::Vec3(a) => values::Vector3::new(Vec3::from_array(*a)).into(),
        Jv::Vec4(a) => values::Vector4::new(Vec4::from_array(*a)).into(),
        Jv::Mtx44(a) => values::Matrix44::new(Mat4::from_cols_array(a)).into(),
        Jv::Rgba(r, g, b, a) => values::Color::new(LtkColor::new(*r, *g, *b, *a)).into(),
        Jv::String(s) => values::String::new(s.clone()).into(),
        Jv::Hash(h) => values::Hash::new(h.hash).into(),
        Jv::File(f) => values::WadChunkLink::new(f.hash).into(),
        Jv::Link(l) => values::ObjectLink::new(l.hash).into(),
        Jv::Flag(b) => values::BitBool::new(*b).into(),
        Jv::Pointer { name, fields } => Lv::Struct(values::Struct {
            class_hash: name.hash,
            properties: fields_to_props(fields)?,
            meta: NoMeta,
        }),
        Jv::Embed { name, fields } => Lv::Embedded(values::Embedded(values::Struct {
            class_hash: name.hash,
            properties: fields_to_props(fields)?,
            meta: NoMeta,
        })),
        Jv::List { value_type, items } => Lv::Container(build_container(*value_type, items)?),
        Jv::List2 { value_type, items } => {
            Lv::UnorderedContainer(UnorderedContainer(build_container(*value_type, items)?))
        }
        Jv::Option { value_type, items } => {
            let inner = match items.first() {
                Some(j) => Some(jv_to_lv(j)?),
                None => None,
            };
            Lv::Optional(
                Optional::new(bt_to_kind(*value_type), inner)
                    .map_err(|e| format!("optional: {e:?}"))?,
            )
        }
        Jv::Map { key_type, value_type, items } => {
            let mut entries = Vec::with_capacity(items.len());
            for (k, v) in items {
                entries.push((jv_to_lv(k)?, jv_to_lv(v)?));
            }
            Lv::Map(
                LtkMap::new(bt_to_kind(*key_type), bt_to_kind(*value_type), entries)
                    .map_err(|e| format!("map: {e:?}"))?,
            )
        }
    })
}

