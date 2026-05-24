//! Stage 1: Troybin binary parser.
//!
//! Direct port of `parser/binary_reader.py` from the Python tool.
//! Reads `.troybin` / `.inibin` files (version 1 "old" and version 2
//! "new") into a list of `(u32 hash, value)` entries. The version byte
//! at offset 0 selects the reader.
//!
//! Sanitization: value strings whose textual form looks numeric / bool /
//! NaN / vector-of-numbers get coerced into the appropriate typed
//! variant. Matches the Python tool's `sanitize_str` byte-for-byte so
//! downstream INI output diffs cleanly against the reference tool.

/// One parsed entry: `(hash, value)`. The hash is the SDBM-style
/// `ihash(section, name)` digest the resolver turns back into a
/// `section.name` pair.
#[derive(Debug, Clone)]
pub struct TroybinEntry {
    pub hash: u32,
    pub value: TroybinValue,
}

/// Variant union for the values an entry can carry. The Python tool
/// uses dynamic typing — these are the concrete shapes that come out
/// of `sanitize_str` + the typed numeric readers.
#[derive(Debug, Clone, PartialEq)]
pub enum TroybinValue {
    /// Floating-point number — Python's `sanitize_str` casts ints to
    /// float too, so most single numeric values flow through this.
    /// Also produced by F32 reads and by any scaled / multi-value
    /// numeric read once the post-round float lands here.
    Number(f64),
    /// Integer-typed numeric value. Distinct from `Number` because
    /// Python's `read_numbers` keeps integer types as Python `int`
    /// when `count == 1 && mul == 1` for integer-format slots (I32 /
    /// I16 / U8 unscaled / U16). The INI writer emits them without
    /// a trailing `.0`, matching the reference tool's output.
    Int(i64),
    /// Multi-component vector. Used both for "raw multi-value reads"
    /// (vec2 / vec3 / vec4 from `read_numbers`) and for whitespace-
    /// separated number lists found in strings.
    Vec(Vec<f64>),
    /// Bool, kept as 0 / 1 like the Python tool does.
    Bool(u8),
    /// A non-numeric string (texture paths, mesh names, etc).
    Str(String),
    /// Not-a-Number — preserved as a marker so the INI writer can
    /// emit `NaN` rather than swallowing it as a normal number.
    NaN,
}

// ── Hand-rolled value classifiers (replaces the Python regexes) ────

/// `^[-+]?\d+$` — optional sign followed by 1+ ASCII digits.
fn is_int_lit(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() { return false; }
    let mut i = 0;
    if bytes[0] == b'+' || bytes[0] == b'-' { i = 1; }
    if i >= bytes.len() { return false; }
    bytes[i..].iter().all(|b| b.is_ascii_digit())
}

/// `^[+-]?\d*\.?\d+(?:[Ee][+-]?\d+)?$` — integer, plain decimal, or
/// scientific notation. The original Python regex requires at least one
/// digit before or after the optional dot, then an optional exponent.
fn is_decimal_lit(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() { return false; }
    let mut i = 0;
    if bytes[0] == b'+' || bytes[0] == b'-' { i = 1; }
    // Mantissa: \d* \.? \d+
    let mantissa_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() { i += 1; }
    let saw_dot = i < bytes.len() && bytes[i] == b'.';
    if saw_dot { i += 1; }
    let frac_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() { i += 1; }
    // Need at least one digit somewhere in the mantissa, and the chars
    // we just walked must include either an int-part or frac-part.
    let int_digits = if saw_dot { frac_start - 1 - mantissa_start } else { i - mantissa_start };
    let frac_digits = if saw_dot { i - frac_start } else { 0 };
    if int_digits == 0 && frac_digits == 0 { return false; }
    // Exponent: ([Ee][+-]?\d+)?
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') { i += 1; }
        let exp_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() { i += 1; }
        if i == exp_start { return false; }
    }
    i == bytes.len()
}

/// Whitespace splitter matching the Python tool's `data.replace("\t",
/// " ").split(" ")` followed by an empty-filter. Returns at least one
/// element; a string of pure whitespace yields an empty result.
fn split_ws_python_compat(s: &str) -> Vec<&str> {
    // Tabs → spaces, then split on space, drop empties. NOT the same
    // as `s.split_whitespace()` (which would also break on other
    // whitespace characters Python's split(" ") preserves).
    let pieces = s.split(|c: char| c == ' ' || c == '\t');
    pieces.filter(|p| !p.is_empty()).collect()
}

/// True iff every whitespace-separated piece is an integer literal AND
/// there are at least two pieces (Python's regex requires one or more
/// `<int> <ws>` groups followed by a final int — so minimum 2).
fn is_int_vec(s: &str) -> bool {
    let parts = split_ws_python_compat(s);
    parts.len() >= 2 && parts.iter().all(|p| is_int_lit(p))
}

/// Same for decimal vectors — and they're checked AFTER int vectors,
/// so we don't need to require a dot here; the Python `RE_DECIMAL_VEC`
/// happens to also match plain integer sequences but `RE_INT_VEC` is
/// tested first, so this branch only sees mixed / float-bearing lists
/// in practice. Mirror that fall-through.
fn is_decimal_vec(s: &str) -> bool {
    let parts = split_ws_python_compat(s);
    parts.len() >= 2 && parts.iter().all(|p| is_decimal_lit(p))
}

/// Port of `sanitize_str` — coerce a raw string read out of a string
/// table into the right typed value. Match-order matters: bool / NaN
/// before integer / decimal so we don't classify the literal "true" as
/// a string.
fn sanitize_str(s: &str) -> TroybinValue {
    if s == "true" { return TroybinValue::Bool(1); }
    if s == "false" { return TroybinValue::Bool(0); }
    if s == "NaN" { return TroybinValue::NaN; }

    if is_int_vec(s) || is_decimal_vec(s) {
        let parts: Vec<f64> = split_ws_python_compat(s)
            .into_iter()
            .filter_map(|p| p.parse::<f64>().ok())
            .collect();
        return TroybinValue::Vec(parts);
    }

    if is_int_lit(s) {
        if let Ok(n) = s.parse::<f64>() {
            return TroybinValue::Number(n);
        }
    }
    if is_decimal_lit(s) {
        if let Ok(n) = s.parse::<f64>() {
            return TroybinValue::Number(n);
        }
    }

    TroybinValue::Str(s.to_string())
}

// ── Binary stream ──────────────────────────────────────────────────

struct BinaryStream<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BinaryStream<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn skip(&mut self, n: usize) { self.pos += n; }
    fn read_bytes(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(n).ok_or("read_bytes overflow")?;
        if end > self.data.len() {
            return Err(format!("read past end (need {n} at {})", self.pos));
        }
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }
    fn read_u8(&mut self) -> Result<u8, String> {
        Ok(self.read_bytes(1)?[0])
    }
    fn read_u16(&mut self) -> Result<u16, String> {
        let b = self.read_bytes(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn read_i16(&mut self) -> Result<i16, String> {
        let b = self.read_bytes(2)?;
        Ok(i16::from_le_bytes([b[0], b[1]]))
    }
    fn read_u32(&mut self) -> Result<u32, String> {
        let b = self.read_bytes(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn read_i32(&mut self) -> Result<i32, String> {
        let b = self.read_bytes(4)?;
        Ok(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn read_f32(&mut self) -> Result<f32, String> {
        let b = self.read_bytes(4)?;
        Ok(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
}

// ── Numeric-format dispatch table ──────────────────────────────────

/// One read-config from the Python `read_conf` table inside `read_new`.
/// Each entry binds a numeric width + count + post-read multiplier.
/// Bools (`flag == 5`) and strings (`flag == 12`) are handled out of
/// band because their wire format is different.
#[derive(Clone, Copy)]
enum NumFmt {
    I32,
    F32,
    U8,
    I16,
    U16,
}

#[derive(Clone, Copy)]
struct NumConfig {
    fmt: NumFmt,
    count: usize,
    mul: f64,
}

// ── Old (v1) format ────────────────────────────────────────────────

fn read_old(stream: &mut BinaryStream) -> Result<Vec<TroybinEntry>, String> {
    stream.skip(3);
    let entry_count = stream.read_u32()? as usize;
    let data_count = stream.read_u32()? as usize;

    let mut offsets: Vec<(u32, u32)> = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        let h = stream.read_u32()?;
        let o = stream.read_u32()?;
        offsets.push((h, o));
    }

    let data = stream.read_bytes(data_count)?.to_vec();

    let mut result = Vec::with_capacity(entry_count);
    for (hash, offset) in offsets {
        let mut o = offset as usize;
        let mut s = String::new();
        while o < data.len() && data[o] != 0 {
            s.push(data[o] as char);
            o += 1;
        }
        result.push(TroybinEntry { hash, value: sanitize_str(&s) });
    }
    Ok(result)
}

// ── New (v2) format ────────────────────────────────────────────────

fn read_bools(stream: &mut BinaryStream) -> Result<Vec<TroybinEntry>, String> {
    let num = stream.read_u16()? as usize;
    let mut keys = Vec::with_capacity(num);
    for _ in 0..num {
        keys.push(stream.read_u32()?);
    }
    let bytes_count = num / 8 + if num % 8 > 0 { 1 } else { 0 };
    let bools_data = stream.read_bytes(bytes_count)?.to_vec();
    let mut result = Vec::with_capacity(num);
    for (j, hash) in keys.into_iter().enumerate() {
        let bit = (bools_data[j / 8] >> (j % 8)) & 1;
        result.push(TroybinEntry { hash, value: TroybinValue::Bool(bit) });
    }
    Ok(result)
}

/// Read `num` u16 entries from the stream into a `(hash, count_or_offset)`
/// list, then for each entry read `count` typed values from the
/// numeric stream — matching `read_numbers` in the Python tool.
///
/// Type preservation: Python keeps the raw `int` vs `float` distinction
/// when `count == 1 && mul == 1` (the else-branch in the reference
/// `read_numbers`). We do the same — F32 reads become `Number(f64)`,
/// integer-format reads become `Int(i64)`. Anything that goes through
/// the rounding path always becomes a float, matching Python's
/// `round(value, 1)` return type.
///
/// Rounding: Python's `round(x, 1)` is half-to-even (banker's), so
/// `round(2.25, 1) == 2.2` and `round(2.35, 1) == 2.4`. Rust's default
/// `f64::round` is half-away-from-zero. We use `round_ties_even` to
/// match Python.
fn read_numbers(stream: &mut BinaryStream, cfg: NumConfig) -> Result<Vec<TroybinEntry>, String> {
    let num = stream.read_u16()? as usize;
    let mut keys = Vec::with_capacity(num);
    for _ in 0..num {
        keys.push(stream.read_u32()?);
    }
    let needs_round = cfg.count != 1 || (cfg.mul - 1.0).abs() > f64::EPSILON;
    let mut result = Vec::with_capacity(num);
    for hash in keys {
        // Read the raw values. We keep the integer-shaped versions
        // alongside the float view so we can route into `Int` vs
        // `Number` at the end without rebuilding the data.
        let mut floats: Vec<f64> = Vec::with_capacity(cfg.count);
        let mut ints: Vec<i64> = Vec::with_capacity(cfg.count);
        let fmt_is_int = !matches!(cfg.fmt, NumFmt::F32);
        for _ in 0..cfg.count {
            let raw_i: Option<i64> = match cfg.fmt {
                NumFmt::I32 => Some(stream.read_i32()? as i64),
                NumFmt::F32 => None,
                NumFmt::U8 => Some(stream.read_u8()? as i64),
                NumFmt::I16 => Some(stream.read_i16()? as i64),
                NumFmt::U16 => Some(stream.read_u16()? as i64),
            };
            let raw_f: f64 = match raw_i {
                Some(i) => i as f64,
                None => stream.read_f32()? as f64,
            };
            let value = if needs_round {
                // `(x * mul * 10).round_ties_even() / 10` to match
                // Python's banker's-rounding `round(value, 1)`.
                let scaled = raw_f * cfg.mul;
                (scaled * 10.0).round_ties_even() / 10.0
            } else {
                raw_f * cfg.mul
            };
            floats.push(value);
            if let Some(i) = raw_i {
                ints.push(i);
            }
        }
        let value = if cfg.count == 1 {
            if needs_round || !fmt_is_int {
                // F32 single-value or any scaled single-value: float.
                // Python's `value = raw * mul` keeps the type of `raw`
                // when mul == 1, but the rounding branch always
                // returns a float.
                TroybinValue::Number(floats[0])
            } else {
                // Integer format, count == 1, mul == 1 — Python keeps
                // it as `int`. Match.
                TroybinValue::Int(ints[0])
            }
        } else {
            // Multi-value reads always go through `round(value, 1)` in
            // Python, returning a list of floats.
            TroybinValue::Vec(floats)
        };
        result.push(TroybinEntry { hash, value });
    }
    Ok(result)
}

fn read_strings(stream: &mut BinaryStream, strings_length: usize) -> Result<Vec<TroybinEntry>, String> {
    // Python tool reads the offset table with `<H` (unsigned u16),
    // so use the U16 numeric variant here. After the Int/Number split
    // in `read_numbers`, U16 single-value reads now come back as
    // `TroybinValue::Int(u16)` rather than `Number(f64)` — handle both
    // so this path stays robust if the typing ever changes again.
    let offsets = read_numbers(stream, NumConfig { fmt: NumFmt::U16, count: 1, mul: 1.0 })?;
    let data = stream.read_bytes(strings_length)?.to_vec();
    let mut result = Vec::with_capacity(offsets.len());
    for entry in offsets {
        let o: usize = match entry.value {
            TroybinValue::Int(i) => i as usize,
            TroybinValue::Number(n) => n.round() as usize,
            _ => return Err("string offset entry wasn't numeric".into()),
        };
        let mut p = o;
        let mut s = String::new();
        while p < data.len() && data[p] != 0 {
            s.push(data[p] as char);
            p += 1;
        }
        result.push(TroybinEntry { hash: entry.hash, value: sanitize_str(&s) });
    }
    Ok(result)
}

/// Read-config table — indexed by flag bit. Python tool's `read_conf`
/// in `read_new`. Slots that need special handling (bools, strings)
/// are tagged via `Option::None` and dispatched out of band.
fn read_conf(i: usize) -> Option<NumOrSpecial> {
    use NumFmt::*;
    Some(match i {
        0 => NumOrSpecial::Num(NumConfig { fmt: I32, count: 1, mul: 1.0 }),
        1 => NumOrSpecial::Num(NumConfig { fmt: F32, count: 1, mul: 1.0 }),
        2 => NumOrSpecial::Num(NumConfig { fmt: U8, count: 1, mul: 0.1 }),
        3 => NumOrSpecial::Num(NumConfig { fmt: I16, count: 1, mul: 1.0 }),
        4 => NumOrSpecial::Num(NumConfig { fmt: U8, count: 1, mul: 1.0 }),
        5 => NumOrSpecial::Bools,
        6 => NumOrSpecial::Num(NumConfig { fmt: U8, count: 3, mul: 0.1 }),
        7 => NumOrSpecial::Num(NumConfig { fmt: F32, count: 3, mul: 1.0 }),
        8 => NumOrSpecial::Num(NumConfig { fmt: U8, count: 2, mul: 0.1 }),
        9 => NumOrSpecial::Num(NumConfig { fmt: F32, count: 2, mul: 1.0 }),
        10 => NumOrSpecial::Num(NumConfig { fmt: U8, count: 4, mul: 0.1 }),
        11 => NumOrSpecial::Num(NumConfig { fmt: F32, count: 4, mul: 1.0 }),
        12 => NumOrSpecial::Strings,
        13 => NumOrSpecial::Num(NumConfig { fmt: I32, count: 1, mul: 1.0 }),
        _ => return None,
    })
}

enum NumOrSpecial {
    Num(NumConfig),
    Bools,
    Strings,
}

fn read_new(stream: &mut BinaryStream) -> Result<Vec<TroybinEntry>, String> {
    let strings_length = stream.read_u16()? as usize;
    let mut flags = stream.read_u16()?;
    // Some files spec a zero flags word followed by the real one — the
    // Python tool reads a second u16 in that case. Mirror the quirk.
    if flags == 0 {
        flags = stream.read_u16()?;
    }

    let mut target: Vec<TroybinEntry> = Vec::new();
    for i in 0..16 {
        if (flags & (1 << i)) == 0 { continue; }
        let Some(conf) = read_conf(i) else { continue; };
        match conf {
            NumOrSpecial::Num(cfg) => target.extend(read_numbers(stream, cfg)?),
            NumOrSpecial::Bools => target.extend(read_bools(stream)?),
            NumOrSpecial::Strings => target.extend(read_strings(stream, strings_length)?),
        }
    }
    Ok(target)
}

/// Public entry point — sniff the version byte and dispatch.
pub fn read_troybin_binary(data: &[u8]) -> Result<Vec<TroybinEntry>, String> {
    if data.is_empty() {
        return Err("Empty troybin data".into());
    }
    let mut stream = BinaryStream::new(data);
    let version = stream.read_u8()?;
    match version {
        2 => read_new(&mut stream),
        1 => read_old(&mut stream),
        v => Err(format!("Unknown troybin version: {}", v)),
    }
}
