/**
 * Zero-dependency parsers for Wrangler JSONC, JSON, and TOML configurations.
 */

function peekNextSignificantChar(text, startIdx) {
  let i = startIdx;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < len && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    return ch;
  }
  return '';
}

export function stripJsonc(input) {
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const len = text.length;
  let out = '';
  let i = 0;
  let state = 'NORMAL';

  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === 'NORMAL') {
      if (ch === '"') {
        state = 'STRING';
        out += ch;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '/') {
        state = 'LINE_COMMENT';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'BLOCK_COMMENT';
        out += ' ';
        i += 2;
        continue;
      }
      if (ch === ',') {
        const sig = peekNextSignificantChar(text, i + 1);
        if (sig === '}' || sig === ']') {
          i += 1;
          continue;
        }
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (state === 'STRING') {
      if (ch === '\\') {
        out += ch;
        if (i + 1 < len) {
          out += text[i + 1];
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === '"') {
        state = 'NORMAL';
      }
      out += ch;
      i += 1;
      continue;
    }

    if (state === 'LINE_COMMENT') {
      if (ch === '\n') {
        out += '\n';
        state = 'NORMAL';
      }
      i += 1;
      continue;
    }

    if (state === 'BLOCK_COMMENT') {
      if (ch === '*' && next === '/') {
        state = 'NORMAL';
        i += 2;
        continue;
      }
      if (ch === '\n') {
        out += '\n';
      }
      i += 1;
      continue;
    }
  }

  if (state === 'BLOCK_COMMENT') {
    throw new SyntaxError('Unterminated block comment in JSONC configuration');
  }

  return out;
}

export function parseJsonc(text) {
  const stripped = stripJsonc(text);
  const parsed = JSON.parse(stripped);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('Wrangler JSON/JSONC configuration root must be an object');
  }
  return parsed;
}

function unescapeBasicTomlString(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const esc = inner[i + 1];
    i += 1;
    if (esc === 'n') out += '\n';
    else if (esc === 'r') out += '\r';
    else if (esc === 't') out += '\t';
    else if (esc === 'b') out += '\b';
    else if (esc === 'f') out += '\f';
    else if (esc === '"') out += '"';
    else if (esc === '\\') out += '\\';
    else if (esc === 'u') {
      const hex = inner.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw new SyntaxError(`Invalid TOML unicode escape: \\u${hex}`);
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else if (esc === 'U') {
      const hex = inner.slice(i + 1, i + 9);
      if (!/^[0-9a-fA-F]{8}$/.test(hex)) {
        throw new SyntaxError(`Invalid TOML unicode escape: \\U${hex}`);
      }
      out += String.fromCodePoint(parseInt(hex, 16));
      i += 8;
    } else if (esc === '\n' || esc === '\r') {
      while (i + 1 < inner.length && /\s/.test(inner[i + 1])) i += 1;
    } else {
      out += esc ?? '';
    }
  }
  return out;
}

function splitTopLevel(text, delimiter) {
  const parts = [];
  let current = '';
  let depthBracket = 0;
  let depthBrace = 0;
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === '"""' || quote === "'''") {
        if (text.slice(i, i + 3) === quote) {
          current += quote;
          i += 2;
          quote = null;
          continue;
        }
        if (quote === '"""' && ch === '\\') {
          current += ch + (text[i + 1] ?? '');
          i += 1;
          continue;
        }
        current += ch;
        continue;
      }
      if (quote === '"' && ch === '\\') {
        current += ch + (text[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      current += ch;
      continue;
    }

    if (text.slice(i, i + 3) === '"""') {
      quote = '"""';
      current += '"""';
      i += 2;
      continue;
    }
    if (text.slice(i, i + 3) === "'''") {
      quote = "'''";
      current += "'''";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') depthBracket += 1;
    else if (ch === ']') depthBracket -= 1;
    else if (ch === '{') depthBrace += 1;
    else if (ch === '}') depthBrace -= 1;

    if (ch === delimiter && depthBracket === 0 && depthBrace === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }

  parts.push(current);
  return parts;
}

function findTopLevelEquals(line) {
  let quote = null;
  let depthBracket = 0;
  let depthBrace = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') depthBracket += 1;
    else if (ch === ']') depthBracket -= 1;
    else if (ch === '{') depthBrace += 1;
    else if (ch === '}') depthBrace -= 1;
    else if (ch === '=' && depthBracket === 0 && depthBrace === 0) {
      return i;
    }
  }
  return -1;
}

function parseKeyPath(rawKey) {
  const parts = splitTopLevel(rawKey.trim(), '.');
  const keys = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new SyntaxError(`Invalid empty TOML key segment in "${rawKey}"`);
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      keys.push(unescapeBasicTomlString(trimmed.slice(1, -1)));
    } else if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
      keys.push(trimmed.slice(1, -1));
    } else if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
      keys.push(trimmed);
    } else {
      throw new SyntaxError(`Invalid TOML key segment "${trimmed}"`);
    }
  }
  return keys;
}

function assignKeyPath(target, keys, value) {
  let cursor = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const seg = keys[i];
    if (cursor[seg] === undefined) {
      cursor[seg] = {};
    } else if (Array.isArray(cursor[seg])) {
      cursor = cursor[seg][cursor[seg].length - 1];
      continue;
    } else if (typeof cursor[seg] !== 'object' || cursor[seg] === null) {
      throw new SyntaxError(`Cannot assign nested key through scalar "${seg}"`);
    }
    cursor = cursor[seg];
  }
  const last = keys[keys.length - 1];
  if (Object.prototype.hasOwnProperty.call(cursor, last)) {
    throw new SyntaxError(`Duplicate TOML key "${keys.join('.')}"`);
  }
  cursor[last] = value;
}

function parseTomlValue(raw) {
  const val = raw.trim();
  if (!val) {
    throw new SyntaxError('Missing TOML value');
  }
  if (val.startsWith('"""') && val.endsWith('"""') && val.length >= 6) {
    let inner = val.slice(3, -3);
    if (inner.startsWith('\n')) inner = inner.slice(1);
    return unescapeBasicTomlString(inner);
  }
  if (val.startsWith("'''") && val.endsWith("'''") && val.length >= 6) {
    let inner = val.slice(3, -3);
    if (inner.startsWith('\n')) inner = inner.slice(1);
    return inner;
  }
  if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
    return unescapeBasicTomlString(val.slice(1, -1));
  }
  if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
    return val.slice(1, -1);
  }
  if (val === 'true') return true;
  if (val === 'false') return false;

  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    const items = splitTopLevel(inner, ',');
    const result = [];
    for (const item of items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      result.push(parseTomlValue(trimmed));
    }
    return result;
  }

  if (val.startsWith('{') && val.endsWith('}')) {
    const inner = val.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    const entries = splitTopLevel(inner, ',');
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const eqIdx = findTopLevelEquals(trimmed);
      if (eqIdx === -1) {
        throw new SyntaxError(`Invalid TOML inline table entry: "${trimmed}"`);
      }
      const kPath = parseKeyPath(trimmed.slice(0, eqIdx));
      const vParsed = parseTomlValue(trimmed.slice(eqIdx + 1));
      assignKeyPath(obj, kPath, vParsed);
    }
    return obj;
  }

  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(val)) {
    return val;
  }

  const numericClean = val.replace(/_/g, '');
  if (/^[+-]?\d+$/.test(numericClean)) {
    return Number.parseInt(numericClean, 10);
  }
  if (/^[+-]?\d+\.\d+(?:[eE][+-]?\d+)?$/.test(numericClean) || /^[+-]?\d+[eE][+-]?\d+$/.test(numericClean)) {
    return Number.parseFloat(numericClean);
  }

  throw new SyntaxError(`Unsupported or invalid TOML value: "${val}"`);
}

function stripTomlCommentsAndBuildStatements(input) {
  const normalized = (input.startsWith('\uFEFF') ? input.slice(1) : input).replace(/\r\n/g, '\n');
  const statements = [];
  let buf = '';
  let quote = null;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];

    if (quote) {
      if (quote === '"""' || quote === "'''") {
        if (normalized.slice(i, i + 3) === quote) {
          buf += quote;
          i += 2;
          quote = null;
          continue;
        }
        if (quote === '"""' && ch === '\\') {
          buf += ch + (normalized[i + 1] ?? '');
          i += 1;
          continue;
        }
        buf += ch;
        continue;
      }
      if (quote === '"' && ch === '\\') {
        buf += ch + (normalized[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (ch === '\n') {
        throw new SyntaxError('Unterminated single-line string in TOML');
      }
      if (ch === quote) {
        quote = null;
      }
      buf += ch;
      continue;
    }

    if (normalized.slice(i, i + 3) === '"""') {
      quote = '"""';
      buf += '"""';
      i += 2;
      continue;
    }
    if (normalized.slice(i, i + 3) === "'''") {
      quote = "'''";
      buf += "'''";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }

    if (ch === '#') {
      while (i < normalized.length && normalized[i] !== '\n') i += 1;
      i -= 1;
      continue;
    }

    if (ch === '[') bracketDepth += 1;
    else if (ch === ']') bracketDepth -= 1;
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth -= 1;

    if (ch === '\n' && bracketDepth <= 0 && braceDepth <= 0) {
      const trimmed = buf.trim();
      if (trimmed) statements.push(trimmed);
      buf = '';
      bracketDepth = 0;
      braceDepth = 0;
      continue;
    }

    buf += ch;
  }

  if (quote) {
    throw new SyntaxError('Unterminated string in TOML');
  }
  if (bracketDepth !== 0 || braceDepth !== 0) {
    throw new SyntaxError('Unbalanced brackets or braces in TOML');
  }
  const tail = buf.trim();
  if (tail) statements.push(tail);
  return statements;
}

export function parseToml(text) {
  const statements = stripTomlCommentsAndBuildStatements(text);
  const root = {};
  let currentTable = root;

  for (const stmt of statements) {
    if (stmt.startsWith('[[') && stmt.endsWith(']]') && findTopLevelEquals(stmt) === -1) {
      const header = stmt.slice(2, -2).trim();
      const keys = parseKeyPath(header);
      let cursor = root;
      for (let i = 0; i < keys.length - 1; i += 1) {
        const seg = keys[i];
        if (cursor[seg] === undefined) {
          cursor[seg] = {};
          cursor = cursor[seg];
        } else if (Array.isArray(cursor[seg])) {
          cursor = cursor[seg][cursor[seg].length - 1];
        } else if (typeof cursor[seg] === 'object' && cursor[seg] !== null) {
          cursor = cursor[seg];
        } else {
          throw new SyntaxError(`Cannot create array of tables under scalar "${seg}"`);
        }
      }
      const last = keys[keys.length - 1];
      if (cursor[last] === undefined) {
        cursor[last] = [];
      } else if (!Array.isArray(cursor[last])) {
        throw new SyntaxError(`Expected "${keys.join('.')}" to be an array of tables`);
      }
      const entry = {};
      cursor[last].push(entry);
      currentTable = entry;
      continue;
    }

    if (stmt.startsWith('[') && stmt.endsWith(']') && findTopLevelEquals(stmt) === -1) {
      const header = stmt.slice(1, -1).trim();
      const keys = parseKeyPath(header);
      let cursor = root;
      for (const seg of keys) {
        if (cursor[seg] === undefined) {
          cursor[seg] = {};
          cursor = cursor[seg];
        } else if (Array.isArray(cursor[seg])) {
          cursor = cursor[seg][cursor[seg].length - 1];
        } else if (typeof cursor[seg] === 'object' && cursor[seg] !== null) {
          cursor = cursor[seg];
        } else {
          throw new SyntaxError(`Cannot open table "${keys.join('.')}" over scalar "${seg}"`);
        }
      }
      currentTable = cursor;
      continue;
    }

    const eqIdx = findTopLevelEquals(stmt);
    if (eqIdx === -1) {
      throw new SyntaxError(`Invalid TOML statement: "${stmt}"`);
    }
    const keyPath = parseKeyPath(stmt.slice(0, eqIdx));
    const value = parseTomlValue(stmt.slice(eqIdx + 1));
    assignKeyPath(currentTable, keyPath, value);
  }

  return root;
}
