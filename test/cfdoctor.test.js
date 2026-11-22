import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli, VERSION } from '../src/cli.js';
import { auditProject, validateCronExpression } from '../src/auditor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'cfdoctor.js');

function makeTempProject(t) {
  const baseCache = fs.existsSync('D:\\Codex\\Projects')
    ? path.join('D:\\Codex\\Projects', '.cache')
    : os.tmpdir();
  fs.mkdirSync(baseCache, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseCache, 'cfdoctor-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeProjectFiles(root, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

test('CLI --help and --version succeed with exit code 0', async () => {
  const outHelp = execFileSync(process.execPath, [BIN_PATH, '--help'], { encoding: 'utf8' });
  assert.match(outHelp, /cfdoctor check \[projectDir\]/);

  const outVer = execFileSync(process.execPath, [BIN_PATH, '--version'], { encoding: 'utf8' });
  assert.equal(outVer.trim(), VERSION);
});

test('clean Worker project with wrangler.jsonc (comments + trailing commas) passes', async (t) => {
  const dir = makeTempProject(t);
  writeProjectFiles(dir, {
    '.gitignore': '.dev.vars\n.wrangler/\nnode_modules/\n',
    '.dev.vars.example': 'JWT_SECRET=\n',
    '.dev.vars': 'JWT_SECRET=super-secret-do-not-print-999\n',
    'wrangler.jsonc': `{
      // Worker configuration with comments and trailing commas
      "name": "clean-worker",
      "main": "src/index.js",
      "compatibility_date": "2025-02-01",
      "compatibility_flags": ["nodejs_compat",],
      "kv_namespaces": [
        {
          "binding": "CACHE",
          "id": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        },
      ],
      "triggers": {
        "crons": ["*/10 * * * *", "0 6 * * MON-FRI",],
      },
      "vars": {
        "APP_ENV": "production", // inline comment
      }, /* block comment */
    }`,
    'src/index.js': `
      import crypto from 'node:crypto';
      export default {
        async fetch(req, env) {
          const digest = crypto.createHash('sha256').update(env.JWT_SECRET + env.APP_ENV).digest('hex');
          await env.CACHE.put('last', digest);
          return new Response('ok');
        }
      };
    `,
  });

  const logs = [];
  const code = await runCli(['check', dir, '--strict', '--json'], {
    stdout: (m) => logs.push(m),
    stderr: (m) => logs.push(m),
  });
  assert.equal(code, 0);
  const report = JSON.parse(logs.join('\n'));
  assert.equal(report.ok, true);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.warnings, 0);
  assert.ok(!logs.join('\n').includes('super-secret-do-not-print-999'));
});

test('clean Worker project with wrangler.toml passes', (t) => {
  const dir = makeTempProject(t);
  writeProjectFiles(dir, {
    '.gitignore': '.dev.vars\n.wrangler\n',
    'wrangler.toml': `
      # Clean TOML configuration
      name = "toml-worker"
      main = "src/worker.mjs"
      compatibility_date = "2025-01-15"

      [vars]
      PUBLIC_NAME = "demo"

      [[d1_databases]]
      binding = "DB"
      database_name = "prod-db"
      database_id = "12345678-9abc-def0-1234-56789abcdef0"

      [ai]
      binding = "AI"

      [triggers]
      crons = [
        "0 */4 * * *",
      ]
    `,
    'src/worker.mjs': `
      export default {
        async fetch(_req, env) {
          return Response.json({ name: env.PUBLIC_NAME, hasDb: Boolean(env.DB), hasAi: Boolean(env.AI) });
        }
      };
    `,
  });

  const report = auditProject(dir, { strict: true });
  assert.equal(report.ok, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.findings.length, 0);
});

test('flags node:crypto import without nodejs_compat and stale compatibility_date (< 2024-09-23)', (t) => {
  const dir = makeTempProject(t);
  writeProjectFiles(dir, {
    '.gitignore': '.dev.vars\n.wrangler/\n',
    'wrangler.toml': `
      name = "legacy-node-worker"
      main = "src/index.js"
      compatibility_date = "2024-05-01"
    `,
    'src/index.js': `
      import { randomBytes } from 'node:crypto';
      export default {
        fetch() {
          return new Response(randomBytes(8).toString('hex'));
        }
      };
    `,
  });

  const report = auditProject(dir);
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 2);
  const codes = report.findings.map((f) => f.code);
  assert.ok(codes.includes('NODEJS_COMPAT_MISSING'));
  assert.ok(codes.includes('COMPATIBILITY_DATE_STALE'));
});

test('detects duplicate bindings across sections and placeholder IDs (TODO, xxxx, empty id)', (t) => {
  const dir = makeTempProject(t);
  writeProjectFiles(dir, {
    '.gitignore': '.dev.vars\n.wrangler/\n',
    'wrangler.jsonc': `{
      "name": "broken-bindings",
      "main": "src/index.js",
      "compatibility_date": "2025-03-01",
      "kv_namespaces": [
        { "binding": "SHARED_NAME", "id": "TODO_REPLACE_KV_ID" },
        { "binding": "KV_TWO", "id": "xxxx-xxxx-xxxx" }
      ],
      "d1_databases": [
        { "binding": "SHARED_NAME", "database_name": "app", "database_id": "" }
      ],
      "r2_buckets": [
        { "binding": "BUCKET", "bucket_name": "real-bucket" }
      ],
      "queues": {
        "producers": [
          { "binding": "SHARED_NAME", "queue": "jobs" }
        ]
      },
      "durable_objects": {
        "bindings": [
          { "name": "BUCKET", "class_name": "CounterDO" }
        ]
      },
      "services": [
        { "binding": "SVC", "service": "auth-svc" }
      ],
      "ai": {
        "binding": "SVC"
      },
      "vars": {
        "SHARED_NAME": "conflict"
      }
    }`,
    'src/index.js': 'export default { fetch() { return new Response("hi"); } };\n',
  });

  const report = auditProject(dir);
  assert.equal(report.exitCode, 2);

  const dupes = report.findings.filter((f) => f.code === 'DUPLICATE_BINDING');
  assert.ok(dupes.length >= 4, `Expected multiple duplicate binding errors, got ${dupes.length}`);

  const placeholders = report.findings.filter((f) => f.code === 'PLACEHOLDER_BINDING_ID');
  assert.equal(placeholders.length, 3);
});

test('validates 5-field cron syntax and rejects invalid cron expressions with exit code 2', (t) => {
  assert.equal(validateCronExpression('*/5 * * * *').valid, true);
  assert.equal(validateCronExpression('0 0 1 JAN MON').valid, true);
  assert.equal(validateCronExpression('* * * *').valid, false);
  assert.equal(validateCronExpression('60 * * * *').valid, false);
  assert.equal(validateCronExpression('0 24 * * *').valid, false);
  assert.equal(validateCronExpression('*/0 * * * *').valid, false);

  const dir = makeTempProject(t);
  writeProjectFiles(dir, {
    '.gitignore': '.dev.vars\n.wrangler/\n',
    'wrangler.toml': `
      name = "bad-cron"
      main = "src/index.js"
      compatibility_date = "2025-01-01"

      [triggers]
      crons = ["* * * *", "99 12 * * *"]
    `,
    'src/index.js': 'export default { scheduled() {} };\n',
  });

  const report = auditProject(dir);
  assert.equal(report.exitCode, 2);
  const cronErrors = report.findings.filter((f) => f.code === 'CRON_INVALID');
  assert.equal(cronErrors.length, 2);
});

test('rejects unignored .dev.vars with exit code 2 and never leaks secret values', async (t) => {
  const dir = makeTempProject(t);
  const secretCanary = 'ULTRA_SECRET_TOKEN_VALUE_847291';
  writeProjectFiles(dir, {
    '.gitignore': 'node_modules/\n',
    '.dev.vars.example': 'STRIPE_SECRET=\nWEBHOOK_SECRET=\n',
    '.dev.vars': `STRIPE_SECRET=${secretCanary}\n`,
    'wrangler.jsonc': `{
      "name": "secret-leak-worker",
      "main": "src/index.js",
      "compatibility_date": "2025-01-01"
    }`,
    'src/index.js': `
      export default {
        fetch(_req, env) {
          return new Response(Boolean(env.STRIPE_SECRET && env.API_TOKEN) ? 'ok' : 'missing');
        }
      };
    `,
  });

  const captured = [];
  const code = await runCli(['check', dir, '--json'], {
    stdout: (m) => captured.push(m),
    stderr: (m) => captured.push(m),
  });

  assert.equal(code, 2);
  const rawOutput = captured.join('\n');
  assert.ok(!rawOutput.includes(secretCanary), 'Secret value must never appear in output');

  const report = JSON.parse(rawOutput);
  const codes = report.findings.map((f) => f.code);
  assert.ok(codes.includes('UNIGNORED_DEV_VARS'));
  assert.ok(codes.includes('GITIGNORE_MISSING_WRANGLER'));
  assert.ok(codes.includes('MISSING_DEV_VARS_KEY'));

  const missingFinding = report.findings.find((f) => f.code === 'MISSING_DEV_VARS_KEY');
  assert.deepEqual(missingFinding.missingKeys, ['API_TOKEN', 'WEBHOOK_SECRET']);
});

test('repository contains zero U+2014 em dashes across all tracked project files', () => {
  const emDash = String.fromCharCode(0x2014);
  const checked = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(full, 'utf8');
        assert.equal(
          content.includes(emDash),
          false,
          `Found forbidden U+2014 em dash in ${path.relative(REPO_ROOT, full)}`
        );
        checked.push(full);
      }
    }
  }

  walk(REPO_ROOT);
  assert.ok(checked.length >= 8);
});
