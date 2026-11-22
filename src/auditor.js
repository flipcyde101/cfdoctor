import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc, parseToml } from './parsers.js';

const CONFIG_CANDIDATES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.wasm']);
const TEXT_SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);
const IGNORED_SCAN_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'coverage', 'test', 'tests', '__tests__']);

const NODE_COMPAT_BASELINE = '2024-09-23';
const SIZE_WARN_BYTES = 3 * 1024 * 1024; // 3 MiB Free plan bundle threshold
const SIZE_ERROR_BYTES = 10 * 1024 * 1024; // 10 MiB Workers standard bundle threshold

const MONTH_NAMES = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DOW_NAMES = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

function isPlaceholderValue(value) {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (/todo|fixme|changeme|replace[-_]?me|placeholder|^your[-_]|^example[-_]?id$/i.test(trimmed)) {
    return true;
  }
  if (/<[^>]+>/.test(trimmed)) return true;
  if (/x{4,}/i.test(trimmed)) return true;
  if (/^[0-]+$/.test(trimmed) && trimmed.replace(/-/g, '').length >= 4) return true;
  return false;
}

function isValidIsoDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function parseCronAtom(token, min, max, aliasMap) {
  const upper = token.toUpperCase();
  if (aliasMap && Object.prototype.hasOwnProperty.call(aliasMap, upper)) {
    return aliasMap[upper];
  }
  if (!/^\d+$/.test(token)) return null;
  const num = Number.parseInt(token, 10);
  if (max === 6 && num === 7) return 0; // Allow 7 for Sunday in day-of-week
  if (num < min || num > max) return null;
  return num;
}

function validateCronField(field, min, max, aliasMap, kind) {
  if (!field || field.trim() !== field) return false;
  const parts = field.split(',');
  for (const part of parts) {
    if (!part) return false;

    if (kind === 'dom' && (part === '?' || part === 'L' || part === 'LW' || /^([1-9]|[12]\d|3[01])W$/.test(part))) {
      continue;
    }
    if (kind === 'dow' && (part === '?' || part === 'L' || /^[0-7]L$/.test(part) || /^[0-7]#[1-5]$/.test(part))) {
      continue;
    }

    const slashSplit = part.split('/');
    if (slashSplit.length > 2) return false;

    const base = slashSplit[0];
    if (slashSplit.length === 2) {
      const stepStr = slashSplit[1];
      if (!/^\d+$/.test(stepStr)) return false;
      const step = Number.parseInt(stepStr, 10);
      if (step <= 0 || step > max - min + 1) return false;
    }

    if (base === '*') continue;

    const dashSplit = base.split('-');
    if (dashSplit.length === 1) {
      if (slashSplit.length === 2) {
        // e.g. 5/15 is valid in standard cron if atom is in range
      }
      const v = parseCronAtom(dashSplit[0], min, max, aliasMap);
      if (v === null) return false;
    } else if (dashSplit.length === 2) {
      const start = parseCronAtom(dashSplit[0], min, max, aliasMap);
      const end = parseCronAtom(dashSplit[1], min, max, aliasMap);
      if (start === null || end === null) return false;
      if (start > end && !(kind === 'dow' && dashSplit[1] === '7')) return false;
    } else {
      return false;
    }
  }
  return true;
}

export function validateCronExpression(expr) {
  if (typeof expr !== 'string') return { valid: false, reason: 'Cron expression must be a string' };
  const trimmed = expr.trim();
  if (!trimmed) return { valid: false, reason: 'Cron expression cannot be empty' };
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return {
      valid: false,
      reason: `Expected 5 cron fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    };
  }
  const [minute, hour, dom, month, dow] = fields;
  if (!validateCronField(minute, 0, 59, null, 'min')) {
    return { valid: false, reason: `Invalid minute field "${minute}" (expected 0-59)` };
  }
  if (!validateCronField(hour, 0, 23, null, 'hour')) {
    return { valid: false, reason: `Invalid hour field "${hour}" (expected 0-23)` };
  }
  if (!validateCronField(dom, 1, 31, null, 'dom')) {
    return { valid: false, reason: `Invalid day-of-month field "${dom}" (expected 1-31)` };
  }
  if (!validateCronField(month, 1, 12, MONTH_NAMES, 'month')) {
    return { valid: false, reason: `Invalid month field "${month}" (expected 1-12 or JAN-DEC)` };
  }
  if (!validateCronField(dow, 0, 6, DOW_NAMES, 'dow')) {
    return { valid: false, reason: `Invalid day-of-week field "${dow}" (expected 0-7 or SUN-SAT)` };
  }
  return { valid: true };
}

function collectSourceFiles(rootDir, explicitEntryPath) {
  const collected = new Map();

  function addFile(fullPath) {
    try {
      const st = fs.statSync(fullPath);
      if (st.isFile()) {
        collected.set(path.resolve(fullPath), st.size);
      }
    } catch {
      // Ignore unreadable files
    }
  }

  if (explicitEntryPath && fs.existsSync(explicitEntryPath)) {
    addFile(explicitEntryPath);
  }

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_SCAN_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) {
          addFile(path.join(dir, entry.name));
        }
      }
    }
  }

  walk(rootDir);
  return collected;
}

function scanSourceUsage(sourceFilesMap) {
  const nodeBuiltins = new Set();
  const referencedEnvKeys = new Set();

  const nodeImportRe =
    /(?:from\s+['"]node:([a-zA-Z0-9_/-]+)['"]|import\s*\(\s*['"]node:([a-zA-Z0-9_/-]+)['"]\s*\)|require\s*\(\s*['"]node:([a-zA-Z0-9_/-]+)['"]\s*\)|import\s+['"]node:([a-zA-Z0-9_/-]+)['"])/g;
  const envAccessRe = /(?<!process\.|meta\.)\benv\.([A-Z][A-Z0-9_]*)\b/g;

  for (const filePath of sourceFilesMap.keys()) {
    const ext = path.extname(filePath).toLowerCase();
    if (!TEXT_SOURCE_EXTENSIONS.has(ext)) continue;
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    // Strip simple JS comments before regex scan to avoid false positives in commented code
    const stripped = content
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:\\])\/\/.*$/gm, '$1 ');

    for (const match of stripped.matchAll(nodeImportRe)) {
      const mod = match[1] || match[2] || match[3] || match[4];
      if (mod) nodeBuiltins.add(`node:${mod}`);
    }

    for (const match of stripped.matchAll(envAccessRe)) {
      if (match[1]) referencedEnvKeys.add(match[1]);
    }
  }

  return {
    nodeBuiltins: [...nodeBuiltins].sort(),
    referencedEnvKeys: [...referencedEnvKeys].sort(),
  };
}

export function parseEnvKeysOnly(content) {
  const keys = new Set();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) {
      keys.add(m[1]);
    }
  }
  return [...keys];
}

function globRuleToRegex(pattern) {
  let pat = pattern;
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.slice(0, -1);
  const anchored = pat.startsWith('/');
  if (anchored) pat = pat.slice(1);

  let escaped = '';
  for (let i = 0; i < pat.length; i += 1) {
    const ch = pat[i];
    if (ch === '*' && pat[i + 1] === '*') {
      escaped += '.*';
      i += 1;
    } else if (ch === '*') {
      escaped += '[^/]*';
    } else if (ch === '?') {
      escaped += '[^/]';
    } else if ('+^$().|[]{}!\\'.includes(ch)) {
      escaped += `\\${ch}`;
    } else {
      escaped += ch;
    }
  }

  const prefix = anchored || pat.includes('/') ? '^' : '(?:^|.*/)';
  const suffix = '(?:$|/.*)';
  return { regex: new RegExp(`${prefix}${escaped}${suffix}`), dirOnly };
}

export function isIgnoredByGitignoreContent(gitignoreContent, candidateRelPath, isDirectory = false) {
  const lines = gitignoreContent.replace(/\r\n/g, '\n').split('\n');
  const normCandidate = candidateRelPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  let ignored = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;

    let negated = false;
    let pattern = line;
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1);
    } else if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
      pattern = pattern.slice(1);
    }
    if (!pattern) continue;

    const { regex, dirOnly } = globRuleToRegex(pattern);
    if (dirOnly && !isDirectory && !normCandidate.includes('/')) {
      continue;
    }
    if (regex.test(normCandidate)) {
      ignored = !negated;
    }
  }

  return ignored;
}

function auditBindingsScope(scopeConfig, scopeLabel, addFinding, allDeclaredBindingNames) {
  const seen = new Map();

  function recordBinding(bindingName, section, scopePrefix) {
    if (typeof bindingName !== 'string' || !bindingName.trim()) {
      addFinding(
        'error',
        'INVALID_BINDING',
        `${scopePrefix}${section} contains an entry with missing or empty binding name`
      );
      return;
    }
    const clean = bindingName.trim();
    allDeclaredBindingNames.add(clean);
    if (seen.has(clean)) {
      const prevSection = seen.get(clean);
      addFinding(
        'error',
        'DUPLICATE_BINDING',
        `${scopePrefix}Duplicate binding name "${clean}" found in ${section} (already declared in ${prevSection})`
      );
    } else {
      seen.set(clean, section);
    }
  }

  const prefix = scopeLabel === 'top-level' ? '' : `[${scopeLabel}] `;

  if (Array.isArray(scopeConfig.kv_namespaces)) {
    for (const item of scopeConfig.kv_namespaces) {
      if (!item || typeof item !== 'object') continue;
      recordBinding(item.binding, 'kv_namespaces', prefix);
      if (isPlaceholderValue(item.id)) {
        addFinding(
          'error',
          'PLACEHOLDER_BINDING_ID',
          `${prefix}kv_namespaces binding "${item.binding || '<unnamed>'}" has empty or placeholder id`
        );
      }
      if (item.preview_id !== undefined && isPlaceholderValue(item.preview_id)) {
        addFinding(
          'error',
          'PLACEHOLDER_BINDING_ID',
          `${prefix}kv_namespaces binding "${item.binding || '<unnamed>'}" has empty or placeholder preview_id`
        );
      }
    }
  }

  if (Array.isArray(scopeConfig.d1_databases)) {
    for (const item of scopeConfig.d1_databases) {
      if (!item || typeof item !== 'object') continue;
      recordBinding(item.binding, 'd1_databases', prefix);
      if (isPlaceholderValue(item.database_id)) {
        addFinding(
          'error',
          'PLACEHOLDER_BINDING_ID',
          `${prefix}d1_databases binding "${item.binding || '<unnamed>'}" has empty or placeholder database_id`
        );
      }
    }
  }

  if (Array.isArray(scopeConfig.r2_buckets)) {
    for (const item of scopeConfig.r2_buckets) {
      if (!item || typeof item !== 'object') continue;
      recordBinding(item.binding, 'r2_buckets', prefix);
      if (isPlaceholderValue(item.bucket_name)) {
        addFinding(
          'error',
          'PLACEHOLDER_BINDING_ID',
          `${prefix}r2_buckets binding "${item.binding || '<unnamed>'}" has empty or placeholder bucket_name`
        );
      }
    }
  }

  const queueProducers = Array.isArray(scopeConfig.queues)
    ? scopeConfig.queues
    : Array.isArray(scopeConfig.queues?.producers)
      ? scopeConfig.queues.producers
      : [];
  for (const item of queueProducers) {
    if (!item || typeof item !== 'object') continue;
    recordBinding(item.binding, 'queues', prefix);
    if (isPlaceholderValue(item.queue)) {
      addFinding(
        'error',
        'PLACEHOLDER_BINDING_ID',
        `${prefix}queues binding "${item.binding || '<unnamed>'}" has empty or placeholder queue name`
      );
    }
  }

  const doBindings = Array.isArray(scopeConfig.durable_objects)
    ? scopeConfig.durable_objects
    : Array.isArray(scopeConfig.durable_objects?.bindings)
      ? scopeConfig.durable_objects.bindings
      : [];
  for (const item of doBindings) {
    if (!item || typeof item !== 'object') continue;
    const bName = item.name ?? item.binding;
    recordBinding(bName, 'durable_objects', prefix);
    if (isPlaceholderValue(item.class_name)) {
      addFinding(
        'error',
        'PLACEHOLDER_BINDING_ID',
        `${prefix}durable_objects binding "${bName || '<unnamed>'}" has empty or placeholder class_name`
      );
    }
  }

  if (Array.isArray(scopeConfig.services)) {
    for (const item of scopeConfig.services) {
      if (!item || typeof item !== 'object') continue;
      recordBinding(item.binding, 'services', prefix);
      if (isPlaceholderValue(item.service)) {
        addFinding(
          'error',
          'PLACEHOLDER_BINDING_ID',
          `${prefix}services binding "${item.binding || '<unnamed>'}" has empty or placeholder service target`
        );
      }
    }
  }

  if (scopeConfig.ai && typeof scopeConfig.ai === 'object' && !Array.isArray(scopeConfig.ai)) {
    recordBinding(scopeConfig.ai.binding, 'ai', prefix);
  }

  if (scopeConfig.assets && typeof scopeConfig.assets === 'object' && scopeConfig.assets.binding) {
    recordBinding(scopeConfig.assets.binding, 'assets', prefix);
  }

  if (scopeConfig.vars && typeof scopeConfig.vars === 'object' && !Array.isArray(scopeConfig.vars)) {
    for (const varKey of Object.keys(scopeConfig.vars)) {
      recordBinding(varKey, 'vars', prefix);
    }
  }
}

export function auditProject(projectDirInput, options = {}) {
  const projectDir = path.resolve(projectDirInput || '.');
  const strict = Boolean(options.strict);
  const findings = [];

  function addFinding(severity, code, message, extra = {}) {
    findings.push({ severity, code, message, ...extra });
  }

  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    addFinding('error', 'PROJECT_DIR_NOT_FOUND', `Project directory does not exist: ${projectDir}`);
    return buildResult(projectDir, null, findings, strict);
  }

  let configPath = null;
  if (options.config) {
    const resolved = path.resolve(projectDir, options.config);
    if (!fs.existsSync(resolved)) {
      addFinding('error', 'CONFIG_MISSING', `Specified config file does not exist: ${resolved}`);
      return buildResult(projectDir, null, findings, strict);
    }
    configPath = resolved;
  } else {
    const found = CONFIG_CANDIDATES.map((name) => path.join(projectDir, name)).filter((p) => fs.existsSync(p));
    if (found.length === 0) {
      addFinding(
        'error',
        'CONFIG_MISSING',
        `No Wrangler configuration found in ${projectDir} (checked ${CONFIG_CANDIDATES.join(', ')})`
      );
      return buildResult(projectDir, null, findings, strict);
    }
    if (found.length > 1) {
      addFinding(
        'warning',
        'MULTIPLE_CONFIGS',
        `Multiple Wrangler config files found (${found.map((f) => path.basename(f)).join(', ')}); auditing ${path.basename(found[0])}`
      );
    }
    configPath = found[0];
  }

  let config;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const ext = path.extname(configPath).toLowerCase();
    if (ext === '.toml') {
      config = parseToml(raw);
    } else {
      config = parseJsonc(raw);
    }
  } catch (err) {
    addFinding(
      'error',
      'CONFIG_PARSE_ERROR',
      `Failed to parse ${path.basename(configPath)}: ${err.message}`
    );
    return buildResult(projectDir, configPath, findings, strict);
  }

  // 1. Entrypoint / Pages output / Assets directory + source size check
  const mainRel = typeof config.main === 'string' ? config.main.trim() : '';
  const pagesOutRel =
    typeof config.pages_build_output_dir === 'string' ? config.pages_build_output_dir.trim() : '';
  const assetsDirRel =
    typeof config.assets === 'string'
      ? config.assets.trim()
      : typeof config.assets?.directory === 'string'
        ? config.assets.directory.trim()
        : '';

  let resolvedMain = null;
  if (!mainRel && !pagesOutRel && !assetsDirRel) {
    addFinding(
      'error',
      'ENTRYPOINT_MISSING',
      'Configuration must specify "main", "pages_build_output_dir", or "assets.directory"'
    );
  } else {
    if (mainRel) {
      resolvedMain = path.resolve(projectDir, mainRel);
      if (!fs.existsSync(resolvedMain) || !fs.statSync(resolvedMain).isFile()) {
        addFinding('error', 'ENTRYPOINT_NOT_FOUND', `Worker entrypoint "${mainRel}" does not exist`);
      } else if (fs.statSync(resolvedMain).size === 0) {
        addFinding('error', 'ENTRYPOINT_EMPTY', `Worker entrypoint "${mainRel}" is empty (0 bytes)`);
      }
    }
    if (assetsDirRel) {
      const resolvedAssets = path.resolve(projectDir, assetsDirRel);
      if (!fs.existsSync(resolvedAssets) || !fs.statSync(resolvedAssets).isDirectory()) {
        addFinding('error', 'ASSETS_DIR_NOT_FOUND', `Assets directory "${assetsDirRel}" does not exist`);
      }
    }
    if (pagesOutRel && !mainRel) {
      const resolvedPages = path.resolve(projectDir, pagesOutRel);
      if (!fs.existsSync(resolvedPages) || !fs.statSync(resolvedPages).isDirectory()) {
        addFinding(
          'warning',
          'PAGES_OUTPUT_DIR_MISSING',
          `Pages build output directory "${pagesOutRel}" does not exist yet`
        );
      }
    }
  }

  const sourceFiles = collectSourceFiles(projectDir, resolvedMain);
  let totalSourceBytes = 0;
  for (const sz of sourceFiles.values()) totalSourceBytes += sz;

  if (totalSourceBytes > SIZE_ERROR_BYTES) {
    addFinding(
      'error',
      'BUNDLE_SIZE_EXCEEDED',
      `Source/bundle size (${formatBytes(totalSourceBytes)}) exceeds 10 MiB Workers limit`
    );
  } else if (totalSourceBytes > SIZE_WARN_BYTES) {
    addFinding(
      'warning',
      'BUNDLE_SIZE_LARGE',
      `Source/bundle size (${formatBytes(totalSourceBytes)}) exceeds 3 MiB Workers Free plan limit`
    );
  }

  // 2. compatibility_date + node:* imports vs nodejs_compat
  const usage = scanSourceUsage(sourceFiles);
  const compatDate = config.compatibility_date;
  const compatFlags = Array.isArray(config.compatibility_flags) ? config.compatibility_flags : [];
  const hasNodeCompat =
    compatFlags.includes('nodejs_compat') || compatFlags.includes('nodejs_compat_v2');

  if (!compatDate) {
    addFinding('error', 'COMPATIBILITY_DATE_MISSING', 'Missing required "compatibility_date" field');
  } else if (!isValidIsoDate(compatDate)) {
    addFinding(
      'error',
      'COMPATIBILITY_DATE_INVALID',
      `Invalid "compatibility_date" value "${compatDate}" (expected YYYY-MM-DD)`
    );
  } else if (compatDate < NODE_COMPAT_BASELINE) {
    if (usage.nodeBuiltins.length > 0 && !hasNodeCompat) {
      addFinding(
        'warning',
        'COMPATIBILITY_DATE_STALE',
        `compatibility_date "${compatDate}" is older than ${NODE_COMPAT_BASELINE} while node:* imports (${usage.nodeBuiltins.join(', ')}) are present without "nodejs_compat"`
      );
    } else if (usage.nodeBuiltins.length > 0) {
      addFinding(
        'warning',
        'COMPATIBILITY_DATE_STALE',
        `compatibility_date "${compatDate}" is older than ${NODE_COMPAT_BASELINE}; update to >= ${NODE_COMPAT_BASELINE} for full nodejs_compat v2 runtime support`
      );
    } else {
      addFinding(
        'warning',
        'COMPATIBILITY_DATE_STALE',
        `compatibility_date "${compatDate}" is older than recommended baseline ${NODE_COMPAT_BASELINE}`
      );
    }
  }

  if (usage.nodeBuiltins.length > 0 && !hasNodeCompat) {
    addFinding(
      'error',
      'NODEJS_COMPAT_MISSING',
      `Source imports built-in Node modules (${usage.nodeBuiltins.join(', ')}) without "nodejs_compat" in compatibility_flags`
    );
  }

  // 3. Duplicate bindings and placeholder IDs (top-level and per env.<name>)
  const allDeclaredBindings = new Set();
  auditBindingsScope(config, 'top-level', addFinding, allDeclaredBindings);
  if (config.env && typeof config.env === 'object' && !Array.isArray(config.env)) {
    for (const [envName, envCfg] of Object.entries(config.env)) {
      if (envCfg && typeof envCfg === 'object' && !Array.isArray(envCfg)) {
        auditBindingsScope(envCfg, `env.${envName}`, addFinding, allDeclaredBindings);
      }
    }
  }

  // 4. Cron trigger 5-field syntax validation
  if (config.triggers !== undefined) {
    const crons = config.triggers?.crons;
    if (crons !== undefined) {
      if (!Array.isArray(crons)) {
        addFinding('error', 'CRON_INVALID', '"triggers.crons" must be an array of 5-field cron strings');
      } else {
        for (const cronExpr of crons) {
          const check = validateCronExpression(cronExpr);
          if (!check.valid) {
            addFinding(
              'error',
              'CRON_INVALID',
              `Invalid cron trigger "${String(cronExpr)}": ${check.reason}`
            );
          }
        }
      }
    }
  }

  // 5. Secret hygiene & .gitignore validation (never include secret values!)
  const devVarsPath = path.join(projectDir, '.dev.vars');
  const devVarsExamplePath = path.join(projectDir, '.dev.vars.example');
  const gitignorePath = path.join(projectDir, '.gitignore');

  const hasDevVars = fs.existsSync(devVarsPath) && fs.statSync(devVarsPath).isFile();
  const hasDevVarsExample =
    fs.existsSync(devVarsExamplePath) && fs.statSync(devVarsExamplePath).isFile();
  const hasGitignore = fs.existsSync(gitignorePath) && fs.statSync(gitignorePath).isFile();

  const gitignoreContent = hasGitignore ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const ignoresDevVars = hasGitignore && isIgnoredByGitignoreContent(gitignoreContent, '.dev.vars', false);
  const ignoresWrangler = hasGitignore && isIgnoredByGitignoreContent(gitignoreContent, '.wrangler', true);

  if (!ignoresDevVars) {
    if (hasDevVars) {
      addFinding(
        'error',
        'UNIGNORED_DEV_VARS',
        '.dev.vars exists on disk but is not excluded by .gitignore'
      );
    } else {
      addFinding(
        'warning',
        'GITIGNORE_MISSING_DEV_VARS',
        '.gitignore does not exclude .dev.vars'
      );
    }
  }

  if (!ignoresWrangler) {
    addFinding(
      'warning',
      'GITIGNORE_MISSING_WRANGLER',
      '.gitignore does not exclude .wrangler'
    );
  }

  const devVarsKeys = hasDevVars
    ? new Set(parseEnvKeysOnly(fs.readFileSync(devVarsPath, 'utf8')))
    : new Set();
  const exampleKeys = hasDevVarsExample
    ? parseEnvKeysOnly(fs.readFileSync(devVarsExamplePath, 'utf8'))
    : [];

  const referencedSecretKeys = usage.referencedEnvKeys.filter(
    (key) => !allDeclaredBindings.has(key)
  );

  const expectedSecretKeys = [...new Set([...exampleKeys, ...referencedSecretKeys])].sort();

  if (expectedSecretKeys.length > 0) {
    if (!hasDevVars) {
      addFinding(
        'warning',
        'DEV_VARS_MISSING',
        `Expected local secret keys (${expectedSecretKeys.join(', ')}) but .dev.vars is not present`,
        { missingKeys: expectedSecretKeys }
      );
    } else {
      const missingInDevVars = expectedSecretKeys.filter((k) => !devVarsKeys.has(k));
      if (missingInDevVars.length > 0) {
        addFinding(
          'warning',
          'MISSING_DEV_VARS_KEY',
          `.dev.vars is missing expected secret keys: ${missingInDevVars.join(', ')}`,
          { missingKeys: missingInDevVars }
        );
      }
    }
  }

  return buildResult(projectDir, configPath, findings, strict, {
    totalSourceBytes,
    sourceFileCount: sourceFiles.size,
    nodeBuiltins: usage.nodeBuiltins,
    declaredBindingsCount: allDeclaredBindings.size,
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function buildResult(projectDir, configPath, findings, strict, stats = {}) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const ok = errors.length === 0 && (!strict || warnings.length === 0);
  const exitCode = ok ? 0 : 2;

  return {
    ok,
    strict,
    exitCode,
    projectDir,
    configFile: configPath ? path.basename(configPath) : null,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      ...stats,
    },
    findings,
  };
}
