/**
 * Custom syntax checker for Ritobin text format.
 *
 * Two severity levels:
 *  - 'error'   (red)    -- broken syntax, file will NOT convert
 *  - 'warning' (yellow) -- valid syntax but won't work as intended in-game
 *
 * Error checks:
 *  - Bracket matching with indent-aware blame
 *  - Type name validation (25 valid types, case-insensitive)
 *  - Container type syntax: list[T], list2[T], option[T], map[K,V]
 *  - Entry/field structure: name: type = value
 *  - String literal syntax (unterminated strings)
 *
 * Warning checks (semantic pass):
 *  - Raw texture + material override on the same submesh (game skips the material)
 *  - Duplicate sampler TextureName inside a StaticMaterialDef (second one ignored)
 *  - Duplicate top-level entry names (unexpected behavior)
 *  - Material override link pointing to a non-existent material in the file
 */

export type SyntaxSeverity = 'error' | 'warning';

export interface SyntaxError {
  line: number;      // 1-based
  column: number;    // 1-based
  length: number;    // how many characters to underline
  message: string;
  severity?: SyntaxSeverity;  // defaults to 'error' when omitted
}

interface BracketEntry {
  char: string;
  line: number;
  column: number;
  indent: number;
}

const BRACKET_PAIRS: Record<string, string> = {
  '{': '}',
  '[': ']',
};

const CLOSING_TO_OPENING: Record<string, string> = {
  '}': '{',
  ']': '[',
};

// All 25 valid ritobin type names (matched case-insensitively)
const VALID_TYPES_LIST = [
  'none', 'bool', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64',
  'f32', 'vec2', 'vec3', 'vec4', 'mtx44', 'rgba', 'string', 'hash', 'file',
  'list', 'list2', 'pointer', 'embed', 'link', 'option', 'map', 'flag',
];
const VALID_TYPES = new Set(VALID_TYPES_LIST);

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Suggest the closest valid type name for a misspelled type.
 * Returns null if no close match is found (distance > 3).
 */
export function suggestType(input: string): string | null {
  const lower = input.toLowerCase();
  let best: string | null = null;
  let bestDist = Infinity;
  for (const t of VALID_TYPES_LIST) {
    const d = levenshtein(lower, t);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= 3 ? best : null;
}

// Container types that require [T] or [K,V] parameters
const CONTAINER_SINGLE = new Set(['list', 'list2', 'option']);
const CONTAINER_MAP = new Set(['map']);

function measureIndent(line: string): number {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') n++;
    else if (line[i] === '\t') n += 4;
    else break;
  }
  return n;
}

/** Check if a character is a valid word character in ritobin (matches Jade's read_word). */
function isWordChar(c: string): boolean {
  return /[A-Za-z0-9_+\-.]/.test(c);
}

interface LineScan {
  contentParts: string;
  unterminatedString: boolean;
  unterminatedStringCol: number;
  unterminatedStringLen: number;
}

function scanLine(line: string, startI: number): LineScan {
  let content = '';
  let i = startI;
  let unterminated = false;
  let untermCol = 0;
  let untermLen = 0;

  while (i < line.length) {
    const ch = line[i];

    // Comment — rest of line is ignored
    if (ch === '#') break;

    // Quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const strStart = i;
      i++; // skip opening quote
      let closed = false;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === quote) { i++; closed = true; break; }
        i++;
      }
      if (!closed) {
        unterminated = true;
        untermCol = strStart;
        untermLen = i - strStart;
      }
      content += ' STRING ';
      continue;
    }

    content += ch;
    i++;
  }

  return { contentParts: content, unterminatedString: unterminated, unterminatedStringCol: untermCol, unterminatedStringLen: untermLen };
}

/**
 * Full syntax check — brackets + type/structure validation.
 */
export function checkSyntax(text: string): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const lines = text.split('\n');

  // ── Pass 1: Bracket matching ──
  const bracketErrors = checkBrackets(text);
  errors.push(...bracketErrors);

  // ── Pass 2: Line-by-line content validation ──
  let braceDepth = 0;
  const blockStack: Array<'section' | 'struct' | 'container'> = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;
    let i = 0;

    // Skip leading whitespace
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

    // Empty line or comment-only line
    if (i >= line.length) continue;
    if (line[i] === '#') continue;

    // Scan for unterminated strings
    const scan = scanLine(line, i);
    if (scan.unterminatedString) {
      errors.push({
        line: lineNum,
        column: scan.unterminatedStringCol + 1,
        length: scan.unterminatedStringLen,
        message: 'Unterminated string',
      });
      updateBraceDepth(line, i);
      continue;
    }

    // Get trimmed content
    const trimmed = scan.contentParts.trim();

    // Skip lines that are just closing braces
    if (trimmed === '}' || trimmed === '{}') {
      if (trimmed === '}' && blockStack.length > 0) blockStack.pop();
      if (trimmed === '}') braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    // Detect and validate type annotations in "name: type = value" patterns
    const colonIdx = findColonInContent(line, i);
    if (colonIdx >= 0) {
      validateTypeAnnotation(line, lineNum, colonIdx, errors);
    }

    // Update brace depth for next line's context
    updateBraceDepth(line, i);
  }

  // ── Pass 3: Semantic warnings (yellow) ──
  // Only run these if there are no bracket errors — unbalanced braces would
  // give the semantic pass garbage context and produce false positives.
  const hasBracketErrors = bracketErrors.length > 0;
  if (!hasBracketErrors) {
    const warnings = checkSemanticWarnings(lines);
    // Expand every warning's squiggle span to the full non-whitespace
    // portion of its line so the user can hover anywhere on the line to
    // see the tooltip. Errors (red) stay narrow to point at the problem.
    for (const w of warnings) {
      if (w.severity !== 'warning') continue;
      const line = lines[w.line - 1];
      if (!line) continue;
      const leading = (line.match(/^(\s*)/)?.[1].length) ?? 0;
      const trailing = line.length - line.trimEnd().length;
      const len = Math.max(1, line.length - leading - trailing);
      w.column = leading + 1;
      w.length = len;
    }
    errors.push(...warnings);
  }

  return errors;

  function updateBraceDepth(line: string, startI: number) {
    let ii = startI;
    while (ii < line.length) {
      const ch = line[ii];
      if (ch === '#') break;
      if (ch === '"' || ch === "'") {
        const q = ch;
        ii++;
        while (ii < line.length) {
          if (line[ii] === '\\') { ii += 2; continue; }
          if (line[ii] === q) { ii++; break; }
          ii++;
        }
        continue;
      }
      if (ch === '{') {
        braceDepth++;
        const before = line.substring(startI, ii).trim().toLowerCase();
        if (/\b(list|list2|option)\s*\[/.test(before) || /\bmap\s*\[/.test(before)) {
          blockStack.push('container');
        } else if (braceDepth === 1) {
          blockStack.push('section');
        } else {
          blockStack.push('struct');
        }
      }
      if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        if (blockStack.length > 0) blockStack.pop();
      }
      ii++;
    }
  }
}

/**
 * Find the first colon in content (not inside strings or comments).
 */
function findColonInContent(line: string, startI: number): number {
  let i = startI;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '#') return -1;
    if (ch === '"' || ch === "'") {
      const q = ch;
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === ':') return i;
    if (ch === '=' || ch === '{' || ch === '}') return -1;
    i++;
  }
  return -1;
}

/**
 * Validate the type annotation after a colon in a "name: type = value" line.
 */
function validateTypeAnnotation(line: string, lineNum: number, colonIdx: number, errors: SyntaxError[]) {
  let i = colonIdx + 1;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  if (i >= line.length || line[i] === '#') {
    errors.push({
      line: lineNum,
      column: colonIdx + 1,
      length: 1,
      message: 'Expected type name after ":"',
    });
    return;
  }

  // Read the type word
  const typeStart = i;
  while (i < line.length && isWordChar(line[i])) i++;
  const typeWord = line.substring(typeStart, i);

  if (typeWord.length === 0) {
    errors.push({
      line: lineNum,
      column: typeStart + 1,
      length: 1,
      message: 'Expected type name after ":"',
    });
    return;
  }

  const typeLower = typeWord.toLowerCase();

  if (!VALID_TYPES.has(typeLower)) {
    errors.push({
      line: lineNum,
      column: typeStart + 1,
      length: typeWord.length,
      message: `Unknown type "${typeWord}"`,
    });
    return;
  }

  // Skip whitespace after type name
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  // Container types must have parameters
  if (CONTAINER_SINGLE.has(typeLower)) {
    if (i >= line.length || line[i] !== '[') {
      errors.push({
        line: lineNum,
        column: typeStart + 1,
        length: typeWord.length,
        message: `"${typeLower}" requires a type parameter, e.g. ${typeLower}[type]`,
      });
      return;
    }
    validateContainerSingleParam(line, lineNum, i, typeLower, errors);
    return;
  }

  if (CONTAINER_MAP.has(typeLower)) {
    if (i >= line.length || line[i] !== '[') {
      errors.push({
        line: lineNum,
        column: typeStart + 1,
        length: typeWord.length,
        message: '"map" requires type parameters, e.g. map[key,value]',
      });
      return;
    }
    validateMapParams(line, lineNum, i, errors);
    return;
  }

  // Non-container types should not have [...]
  if (i < line.length && line[i] === '[') {
    errors.push({
      line: lineNum,
      column: typeStart + 1,
      length: typeWord.length,
      message: `"${typeLower}" does not take type parameters`,
    });
    return;
  }
}

/**
 * Validate container[T] syntax — list[T], list2[T], option[T]
 */
function validateContainerSingleParam(line: string, lineNum: number, bracketIdx: number, typeName: string, errors: SyntaxError[]) {
  let i = bracketIdx + 1;

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  const innerStart = i;
  while (i < line.length && isWordChar(line[i])) i++;
  const innerWord = line.substring(innerStart, i);

  if (innerWord.length === 0) {
    errors.push({
      line: lineNum,
      column: bracketIdx + 1,
      length: 1,
      message: `Expected type name inside ${typeName}[...]`,
    });
    return;
  }

  const innerLower = innerWord.toLowerCase();
  if (!VALID_TYPES.has(innerLower)) {
    errors.push({
      line: lineNum,
      column: innerStart + 1,
      length: innerWord.length,
      message: `Unknown type "${innerWord}" in ${typeName}[...]`,
    });
    return;
  }

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  if (i >= line.length || line[i] !== ']') {
    errors.push({
      line: lineNum,
      column: i + 1,
      length: 1,
      message: `Expected "]" to close ${typeName}[${innerWord}`,
    });
    return;
  }
}

/**
 * Validate map[K,V] syntax.
 */
function validateMapParams(line: string, lineNum: number, bracketIdx: number, errors: SyntaxError[]) {
  let i = bracketIdx + 1;

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  // Read key type
  const keyStart = i;
  while (i < line.length && isWordChar(line[i])) i++;
  const keyWord = line.substring(keyStart, i);

  if (keyWord.length === 0) {
    errors.push({
      line: lineNum,
      column: bracketIdx + 1,
      length: 1,
      message: 'Expected key type name inside map[...]',
    });
    return;
  }

  const keyLower = keyWord.toLowerCase();
  if (!VALID_TYPES.has(keyLower)) {
    errors.push({
      line: lineNum,
      column: keyStart + 1,
      length: keyWord.length,
      message: `Unknown key type "${keyWord}" in map[...]`,
    });
    return;
  }

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  if (i >= line.length || line[i] !== ',') {
    errors.push({
      line: lineNum,
      column: i + 1,
      length: 1,
      message: 'Expected "," between key and value types in map[key,value]',
    });
    return;
  }
  i++;

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  // Read value type
  const valStart = i;
  while (i < line.length && isWordChar(line[i])) i++;
  const valWord = line.substring(valStart, i);

  if (valWord.length === 0) {
    errors.push({
      line: lineNum,
      column: valStart + 1,
      length: 1,
      message: 'Expected value type name inside map[key,...]',
    });
    return;
  }

  const valLower = valWord.toLowerCase();
  if (!VALID_TYPES.has(valLower)) {
    errors.push({
      line: lineNum,
      column: valStart + 1,
      length: valWord.length,
      message: `Unknown value type "${valWord}" in map[...]`,
    });
    return;
  }

  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

  if (i >= line.length || line[i] !== ']') {
    errors.push({
      line: lineNum,
      column: i + 1,
      length: 1,
      message: `Expected "]" to close map[${keyWord},${valWord}`,
    });
    return;
  }
}

/**
 * Check bracket matching in ritobin text content.
 * Skips brackets inside strings (double/single-quoted) and comments (#).
 */
export function checkBrackets(text: string): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const stack: BracketEntry[] = [];
  const lines = text.split('\n');

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;
    const lineIndent = measureIndent(line);
    let i = 0;

    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;

    if (line[i] === '#') continue;

    while (i < line.length) {
      const ch = line[i];

      if (ch === '#') break;

      if (ch === '"') {
        i++;
        while (i < line.length) {
          if (line[i] === '\\') { i += 2; continue; }
          if (line[i] === '"') { i++; break; }
          i++;
        }
        continue;
      }

      if (ch === "'") {
        i++;
        while (i < line.length) {
          if (line[i] === '\\') { i += 2; continue; }
          if (line[i] === "'") { i++; break; }
          i++;
        }
        continue;
      }

      if (ch === '{' || ch === '[') {
        stack.push({ char: ch, line: lineNum, column: i + 1, indent: lineIndent });
        i++;
        continue;
      }

      if (ch === '}' || ch === ']') {
        const expectedOpener = CLOSING_TO_OPENING[ch];

        if (stack.length === 0) {
          errors.push({
            line: lineNum,
            column: i + 1,
            length: 1,
            message: `Unexpected '${ch}' — no matching '${expectedOpener}'`,
          });
          i++;
          continue;
        }

        const top = stack[stack.length - 1];
        const isSameLine = top.line === lineNum;
        const isStructural = (i === lineIndent);

        // ── Case 1: Inline pair (opener on same line) ──
        if (isSameLine && top.char === expectedOpener) {
          stack.pop();
          i++;
          continue;
        }

        // ── Case 2: Structural closer (first char on its line) ──
        if (isStructural) {
          if (top.char === expectedOpener && top.indent === lineIndent) {
            stack.pop();
            i++;
            continue;
          }

          let matchIdx = -1;
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].char === expectedOpener && stack[s].indent === lineIndent) {
              matchIdx = s;
              break;
            }
          }

          if (matchIdx >= 0) {
            for (let s = stack.length - 1; s > matchIdx; s--) {
              const bad = stack[s];
              errors.push({
                line: bad.line,
                column: bad.column,
                length: 1,
                message: `Unclosed '${bad.char}' — no matching '${BRACKET_PAIRS[bad.char]}'`,
              });
            }
            stack.splice(matchIdx);
            i++;
            continue;
          }

          if (top.char === expectedOpener) {
            stack.pop();
            i++;
            continue;
          }

          matchIdx = -1;
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s].char === expectedOpener) {
              matchIdx = s;
              break;
            }
          }
          if (matchIdx >= 0) {
            for (let s = stack.length - 1; s > matchIdx; s--) {
              const bad = stack[s];
              errors.push({
                line: bad.line,
                column: bad.column,
                length: 1,
                message: `Unclosed '${bad.char}' — no matching '${BRACKET_PAIRS[bad.char]}'`,
              });
            }
            stack.splice(matchIdx);
            i++;
            continue;
          }

          errors.push({
            line: lineNum,
            column: i + 1,
            length: 1,
            message: `Mismatched '${ch}' — expected '${BRACKET_PAIRS[top.char]}' to close '${top.char}' opened at line ${top.line}`,
          });
          stack.pop();
          i++;
          continue;
        }

        // ── Case 3: Non-structural, non-same-line closer ──
        errors.push({
          line: lineNum,
          column: i + 1,
          length: 1,
          message: `Extra '${ch}' — a block-closing bracket should be on its own line`,
        });
        i++;
        continue;
      }

      i++;
    }
  }

  for (const entry of stack) {
    errors.push({
      line: entry.line,
      column: entry.column,
      length: 1,
      message: `Unclosed '${entry.char}' — expected '${BRACKET_PAIRS[entry.char]}'`,
    });
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic warning pass
//
// Walks the full document once, collects structural facts (top-level entry
// names, StaticMaterialDef sampler names per entry, per-submesh texture/override
// assignments), then emits yellow warnings for things the game will silently
// mishandle even though the file converts fine.
// ─────────────────────────────────────────────────────────────────────────────

interface SemanticEntryInfo {
  name: string;
  line: number;
  column: number;
  length: number;
  classType: string;
}

function checkSemanticWarnings(lines: string[]): SyntaxError[] {
  const warnings: SyntaxError[] = [];

  // 1. Collect entry names inside skinMeshProperties and watch for duplicates.
  //    Only entries within skinMeshProperties scope are checked — two separate
  //    StaticMaterialDef blocks sharing sub-field names is normal and expected.
  const entryRe = /^\s*("([^"]+)"|0x[0-9a-fA-F]+)\s*=\s*(\w+)\s*\{/;
  const entriesByName = new Map<string, SemanticEntryInfo[]>();

  // Find skinMeshProperties scope boundaries
  let smpStart = -1;
  let smpEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/skinMeshProperties\s*:/.test(lines[i]) && lines[i].includes('{')) {
      smpStart = i;
      let depth = 0;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        if (depth <= 0) { smpEnd = j; break; }
      }
      break;
    }
  }

  for (let idx = 0; idx < lines.length; idx++) {
    // Only check for duplicates inside skinMeshProperties
    if (smpStart !== -1 && (idx < smpStart || idx > smpEnd)) continue;

    const line = lines[idx];
    const m = entryRe.exec(line);
    if (!m) continue;
    const name = m[2] ?? m[1]; // quoted name or hex hash
    const classType = m[3];
    const colIdx = line.indexOf(m[1]);
    const info: SemanticEntryInfo = {
      name,
      line: idx + 1,
      column: colIdx + 1,
      length: m[1].length,
      classType,
    };
    const existing = entriesByName.get(name);
    if (existing) {
      existing.push(info);
    } else {
      entriesByName.set(name, [info]);
    }
  }

  // Duplicate entry name warnings — flag every occurrence after the first
  for (const [name, infos] of entriesByName.entries()) {
    if (infos.length < 2) continue;
    for (let i = 1; i < infos.length; i++) {
      warnings.push({
        line: infos[i].line,
        column: infos[i].column,
        length: infos[i].length,
        message: `Duplicate entry name "${name}" — may cause unexpected behavior`,
        severity: 'warning',
      });
    }
  }

  // 2. Collect material definition names (for override link validation).
  //    Scan the whole file, not just skinMeshProperties — StaticMaterialDef
  //    entries live at the top level outside skinMeshProperties.
  const materialDefNames = new Set<string>();
  for (let idx = 0; idx < lines.length; idx++) {
    const m = entryRe.exec(lines[idx]);
    if (m && m[3] === 'StaticMaterialDef') {
      materialDefNames.add(m[2] ?? m[1]);
    }
  }

  // 3. Walk StaticMaterialDef blocks and collect duplicate samplers.
  //    Each material has its own sampler namespace — a sampler name can
  //    appear in many materials, but within ONE material it should only
  //    appear once. Track brace depth to know when we've left the material.
  {
    let inMaterialDef = false;
    let matDepth = 0;
    let currentMaterialName = '';
    let seenSamplerNames = new Map<string, number>(); // name -> first-seen line

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];

      if (!inMaterialDef) {
        const entryMatch = entryRe.exec(line);
        if (entryMatch && entryMatch[3] === 'StaticMaterialDef') {
          inMaterialDef = true;
          currentMaterialName = entryMatch[2] ?? entryMatch[1];
          matDepth = 0;
          seenSamplerNames = new Map();
          for (const ch of line) {
            if (ch === '{') matDepth++;
            else if (ch === '}') matDepth--;
          }
          continue;
        }
      } else {
        // Update brace depth for this line
        for (const ch of line) {
          if (ch === '{') matDepth++;
          else if (ch === '}') matDepth--;
        }

        const texNameMatch = /TextureName\s*:\s*string\s*=\s*"([^"]+)"/.exec(line);
        if (texNameMatch) {
          const samplerName = texNameMatch[1];
          if (seenSamplerNames.has(samplerName)) {
            const colIdx = line.indexOf(samplerName);
            warnings.push({
              line: idx + 1,
              column: colIdx + 1,
              length: samplerName.length,
              message: `Duplicate sampler "${samplerName}" in ${currentMaterialName || 'material'} — only the first entry will be used`,
              severity: 'warning',
            });
          } else {
            seenSamplerNames.set(samplerName, idx + 1);
          }
        }

        // Left the material block — reset for the next one
        if (matDepth <= 0) {
          inMaterialDef = false;
          currentMaterialName = '';
          seenSamplerNames = new Map();
        }
      }
    }
  }

  // 4. Cross-reference: raw texture + material override on same submesh
  //    Collect all SkinMeshDataProperties_MaterialOverride entries and any
  //    raw texture/material pairs on SkinMeshDataProperties entries, then
  //    flag submeshes that appear in both.
  //
  //    Format for overrides:
  //      SkinMeshDataProperties_MaterialOverride {
  //        material: link = "<name>"
  //        submesh: string = "<submesh>"
  //      }
  //
  //    Format for raw textures (typically a sibling texture field on the
  //    same properties struct): texture: string = "..."
  //    These don't have a per-submesh binding the way overrides do — they
  //    apply to the whole SKL mesh — so we flag a conflict when both a
  //    raw `texture:` and at least one materialOverride exist inside the
  //    same SkinMeshDataProperties block.
  const conflicts = findTextureOverrideConflicts(lines);
  warnings.push(...conflicts);

  // 5. Per-submesh override validation within skinMeshProperties.
  //    A submesh can only have ONE override at a time (either a material
  //    link OR a texture, not multiple). Flag:
  //    - Same (submesh, texture) pair appearing twice (literal copy-paste)
  //    - Any submesh with more than one override entry (conflicting assignment)
  if (smpStart !== -1 && smpEnd !== -1) {
    const texRe = /texture\s*:\s*string\s*=\s*"([^"]+)"/;
    const materialRe = /material\s*:\s*link\s*=\s*"([^"]+)"/;
    const submeshRe = /submesh\s*:\s*string\s*=\s*"([^"]+)"/;

    interface OvInfo {
      submesh: string;
      texture: string;
      material: string;
      // Line/col for warning anchor: prefer the submesh line
      submeshLine: number;
      submeshCol: number;
      submeshLen: number;
      textureLine: number;
      textureCol: number;
      textureLen: number;
    }

    const seenPair = new Map<string, number>(); // "submesh|texture" → first line
    const overridesBySubmesh = new Map<string, OvInfo[]>();
    let inOv = false;
    let ovDepth = 0;
    let cur: OvInfo | null = null;

    for (let i = smpStart; i <= smpEnd; i++) {
      const line = lines[i];
      if (!inOv) {
        if (/SkinMeshDataProperties_MaterialOverride\s*\{/.test(line)) {
          inOv = true;
          ovDepth = 0;
          cur = {
            submesh: '', texture: '', material: '',
            submeshLine: -1, submeshCol: -1, submeshLen: 0,
            textureLine: -1, textureCol: -1, textureLen: 0,
          };
          for (const ch of line) {
            if (ch === '{') ovDepth++;
            else if (ch === '}') ovDepth--;
          }
        }
        continue;
      }

      for (const ch of line) {
        if (ch === '{') ovDepth++;
        else if (ch === '}') ovDepth--;
      }

      const sm = submeshRe.exec(line);
      if (sm && cur) {
        cur.submesh = sm[1].toLowerCase();
        cur.submeshLine = i + 1;
        cur.submeshCol = line.indexOf(sm[1]) + 1;
        cur.submeshLen = sm[1].length;
      }

      const tm = texRe.exec(line);
      if (tm && cur) {
        cur.texture = tm[1].toLowerCase();
        cur.textureLine = i + 1;
        cur.textureCol = line.indexOf(tm[1]) + 1;
        cur.textureLen = tm[1].length;
      }

      const mm = materialRe.exec(line);
      if (mm && cur) {
        cur.material = mm[1].toLowerCase();
      }

      if (ovDepth <= 0 && cur) {
        // Duplicate (submesh, texture) pair
        if (cur.submesh && cur.texture && cur.textureLine > 0) {
          const key = `${cur.submesh}|${cur.texture}`;
          const firstLine = seenPair.get(key);
          if (firstLine !== undefined) {
            warnings.push({
              line: cur.textureLine,
              column: cur.textureCol,
              length: cur.textureLen,
              message: `Duplicate texture on submesh "${cur.submesh}" — same as line ${firstLine}`,
              severity: 'warning',
            });
          } else {
            seenPair.set(key, cur.textureLine);
          }
        }

        // Track all overrides for this submesh to detect multiple
        // conflicting entries below
        if (cur.submesh) {
          const list = overridesBySubmesh.get(cur.submesh) ?? [];
          list.push(cur);
          overridesBySubmesh.set(cur.submesh, list);
        }

        inOv = false;
        cur = null;
      }
    }

    // Flag submeshes with more than one override — game only applies one
    for (const [submesh, ovs] of overridesBySubmesh.entries()) {
      if (ovs.length < 2) continue;
      // First override is "winner", rest are ignored — flag each subsequent one
      for (let k = 1; k < ovs.length; k++) {
        const o = ovs[k];
        warnings.push({
          line: o.submeshLine,
          column: o.submeshCol,
          length: o.submeshLen,
          message: `Submesh "${submesh}" already has an override — this one will be ignored`,
          severity: 'warning',
        });
      }
    }
  }

  // 6. Duplicate Diffuse_Texture paths across StaticMaterialDef blocks.
  //    Two different materials sharing the same diffuse texture is usually
  //    a copy-paste mistake — the user likely forgot to update the path.
  {
    const entryStart = /^\s*("([^"]+)"|0x[0-9a-fA-F]+)\s*=\s*StaticMaterialDef\s*\{/;
    let currentMat = '';
    let depth = 0;
    let inside = false;
    let inSampler = false;
    let samplerDepth = 0;
    let currentSamplerName = '';
    // materialName → { texturePath, line }
    const diffuseByMat = new Map<string, { path: string; line: number }>();
    // texturePath → first materialName
    const diffuseByPath = new Map<string, string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inside) {
        const m = entryStart.exec(line);
        if (m) {
          currentMat = m[2] ?? m[1];
          inside = true;
          depth = 0;
          inSampler = false;
          currentSamplerName = '';
        }
      }
      if (!inside) continue;

      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }

      // Track sampler blocks
      if (/StaticMaterialShaderSamplerDef\s*\{/.test(line)) {
        inSampler = true;
        samplerDepth = 0;
        currentSamplerName = '';
        for (const ch of line) {
          if (ch === '{') samplerDepth++;
          else if (ch === '}') samplerDepth--;
        }
      } else if (inSampler) {
        for (const ch of line) {
          if (ch === '{') samplerDepth++;
          else if (ch === '}') samplerDepth--;
        }
        const nameMatch = /TextureName\s*:\s*string\s*=\s*"([^"]+)"/.exec(line);
        if (nameMatch) currentSamplerName = nameMatch[1];

        if (currentSamplerName === 'Diffuse_Texture') {
          const tpMatch = /texturePath\s*:\s*string\s*=\s*"([^"]+)"/.exec(line);
          if (tpMatch) {
            const tp = tpMatch[1].toLowerCase();
            diffuseByMat.set(currentMat, { path: tp, line: i + 1 });
            const firstMat = diffuseByPath.get(tp);
            if (firstMat && firstMat !== currentMat) {
              const col = line.indexOf(tpMatch[1]);
              warnings.push({
                line: i + 1,
                column: col + 1,
                length: tpMatch[1].length,
                message: `Duplicate Diffuse_Texture — same path used by material "${firstMat}"`,
                severity: 'warning',
              });
            } else if (!firstMat) {
              diffuseByPath.set(tp, currentMat);
            }
          }
        }

        if (samplerDepth <= 0) {
          inSampler = false;
          currentSamplerName = '';
        }
      }

      if (depth <= 0) inside = false;
    }
  }

  // 7. Top-level raw texture + materialOverride coexistence check.
  //    When skinMeshProperties has BOTH a top-level `texture: string`
  //    (the whole-mesh raw texture, typically used by old champions) AND
  //    a `materialOverride` list, warn the user — the raw texture can
  //    take priority over overrides and usually isn't intentional on
  //    custom skins.
  if (smpStart !== -1 && smpEnd !== -1) {
    // Find the top-level texture: string line — one that sits directly
    // inside skinMeshProperties (not inside a nested override block).
    let depth = 0;
    let rawTextureLine: { line: number; col: number; len: number } | null = null;
    let hasOverrideList = false;
    const texRe = /^(\s*)texture\s*:\s*string\s*=\s*"([^"]+)"/;
    const overrideListRe = /materialOverride\s*:\s*list\s*\[\s*embed\s*\]\s*=\s*\{/;

    for (let i = smpStart; i <= smpEnd; i++) {
      const line = lines[i];
      // Skip the opening line itself — its brace is counted next
      if (i === smpStart) {
        for (const ch of line) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        continue;
      }

      // Depth 1 means we're a direct child of skinMeshProperties
      if (depth === 1) {
        if (!rawTextureLine) {
          const m = texRe.exec(line);
          if (m) {
            // Span the whole non-whitespace portion of the line so the
            // user can hover anywhere on the line to see the warning.
            const leading = line.match(/^(\s*)/)?.[1].length ?? 0;
            const trailing = line.length - line.trimEnd().length;
            rawTextureLine = {
              line: i + 1,
              col: leading + 1,
              len: Math.max(1, line.length - leading - trailing),
            };
          }
        }
        if (overrideListRe.test(line)) hasOverrideList = true;
      }

      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
    }

    if (rawTextureLine && hasOverrideList) {
      warnings.push({
        line: rawTextureLine.line,
        column: rawTextureLine.col,
        length: rawTextureLine.len,
        message: `File has a materialOverride — the raw texture here may take priority over the overrides. Make sure this is intended.`,
        severity: 'warning',
      });
    }
  }

  // 8. Material override link pointing to a non-existent material
  //    Walk overrides and check if the link target exists in materialDefNames
  //    OR if the link has the form 0x<hex> (we can't resolve hashes so skip).
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const m = /material\s*:\s*link\s*=\s*"([^"]+)"/.exec(line);
    if (!m) continue;
    const target = m[1];
    // Skip hex hash links — we can't resolve them without the hash tables
    if (/^0x[0-9a-fA-F]+$/.test(target)) continue;
    if (!materialDefNames.has(target)) {
      const colIdx = line.indexOf(target);
      warnings.push({
        line: idx + 1,
        column: colIdx + 1,
        length: target.length,
        message: `Material "${target}" not found in this file`,
        severity: 'warning',
      });
    }
  }

  return warnings;
}

/**
 * Walk SkinMeshDataProperties blocks and find ones that contain BOTH a
 * `texture: string = "..."` line AND a `materialOverride` whose linked
 * material uses the SAME texture path. Having a raw texture alongside a
 * material override that uses a completely different texture is valid —
 * only an actual path collision is flagged.
 */
function findTextureOverrideConflicts(lines: string[]): SyntaxError[] {
  const out: SyntaxError[] = [];

  // Pre-collect texture paths used by each StaticMaterialDef so we can
  // compare them against the raw texture field later.
  const materialTextures = new Map<string, Set<string>>(); // name → texturePaths
  {
    const entryRe = /^\s*("([^"]+)"|0x[0-9a-fA-F]+)\s*=\s*StaticMaterialDef\s*\{/;
    let currentName = '';
    let depth = 0;
    let inside = false;
    for (const line of lines) {
      if (!inside) {
        const m = entryRe.exec(line);
        if (m) {
          currentName = m[2] ?? m[1];
          inside = true;
          depth = 0;
          materialTextures.set(currentName, new Set());
        }
      }
      if (inside) {
        for (const ch of line) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        const tp = /texturePath\s*:\s*string\s*=\s*"([^"]*)"/.exec(line);
        if (tp) materialTextures.get(currentName)!.add(tp[1].toLowerCase());
        if (depth <= 0) inside = false;
      }
    }
  }

  let inProps = false;
  let propsDepth = 0;
  let rawTextureLine: { line: number; column: number; length: number } | null = null;
  let rawTexturePath = '';
  let overrideLinks: Array<{ line: number; column: number; length: number; materialName: string }> = [];

  let inOverride = false;
  let overrideDepth = 0;
  let pendingLinkLine = -1;
  let pendingLinkCol = -1;
  let pendingLinkLen = 0;
  let pendingMaterialName = '';

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.trim();

    if (!inProps) {
      if (/SkinMeshDataProperties\b[^_]/.test(trimmed) && trimmed.endsWith('{')) {
        inProps = true;
        propsDepth = 1;
        rawTextureLine = null;
        rawTexturePath = '';
        overrideLinks = [];
        continue;
      }
      if (/^\s*SkinMeshDataProperties\s*\{/.test(line)) {
        inProps = true;
        propsDepth = 1;
        rawTextureLine = null;
        rawTexturePath = '';
        overrideLinks = [];
        continue;
      }
      continue;
    }

    let localOpen = 0;
    let localClose = 0;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '#') break;
      if (ch === '{') localOpen++;
      else if (ch === '}') localClose++;
    }
    propsDepth += localOpen - localClose;

    const texMatch = /^(\s*)texture\s*:\s*string\s*=\s*"([^"]*)"/.exec(line);
    if (texMatch) {
      const col = line.indexOf('texture');
      rawTextureLine = { line: idx + 1, column: col + 1, length: 'texture'.length };
      rawTexturePath = texMatch[2].toLowerCase();
    }

    if (/SkinMeshDataProperties_MaterialOverride\s*\{/.test(trimmed)) {
      inOverride = true;
      overrideDepth = 1;
      pendingLinkLine = -1;
      pendingMaterialName = '';
    } else if (inOverride) {
      const linkMatch = /material\s*:\s*link\s*=\s*"([^"]+)"/.exec(line);
      if (linkMatch) {
        pendingLinkLine = idx + 1;
        pendingLinkCol = line.indexOf(linkMatch[1]) + 1;
        pendingLinkLen = linkMatch[1].length;
        pendingMaterialName = linkMatch[1];
      }
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci];
        if (ch === '#') break;
        if (ch === '{') overrideDepth++;
        else if (ch === '}') {
          overrideDepth--;
          if (overrideDepth <= 0) {
            if (pendingLinkLine > 0) {
              overrideLinks.push({
                line: pendingLinkLine,
                column: pendingLinkCol,
                length: pendingLinkLen,
                materialName: pendingMaterialName,
              });
            }
            inOverride = false;
            break;
          }
        }
      }
    }

    if (propsDepth <= 0) {
      // Only warn when the raw texture path actually overlaps with a
      // linked material's textures. Different textures = intentional.
      if (rawTextureLine && rawTexturePath && overrideLinks.length > 0) {
        for (const link of overrideLinks) {
          const matTextures = materialTextures.get(link.materialName);
          if (matTextures && matTextures.has(rawTexturePath)) {
            out.push({
              line: rawTextureLine.line,
              column: rawTextureLine.column,
              length: rawTextureLine.length,
              message: `Raw texture duplicates a texture in material "${link.materialName}" — override may be ignored`,
              severity: 'warning',
            });
            out.push({
              line: link.line,
              column: link.column,
              length: link.length,
              message: `Material override uses the same texture as the raw texture field`,
              severity: 'warning',
            });
          }
        }
      }
      inProps = false;
      propsDepth = 0;
      inOverride = false;
      rawTextureLine = null;
      rawTexturePath = '';
      overrideLinks = [];
    }
  }

  return out;
}
