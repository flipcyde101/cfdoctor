import fs from 'node:fs';
import { auditProject } from './auditor.js';

const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'));

export const VERSION = pkg.version;

export const HELP_TEXT = `cfdoctor v${VERSION}
Cloudflare Workers & Pages configuration preflight auditor.

Usage:
  cfdoctor check [projectDir] [options]
  cfdoctor --help | --version

Options:
  --strict           Treat warnings as hard errors (exit 2)
  --json             Output structured JSON report
  --config <file>    Explicit Wrangler config file path
  -h, --help         Show this help message
  -v, --version      Print version

Exit codes:
  0  Preflight passed
  1  Invalid CLI arguments
  2  Preflight failed with hard errors (or warnings under --strict)
`;

export function parseCliArgs(argv) {
  const positional = [];
  const flags = {
    strict: false,
    json: false,
    help: false,
    version: false,
    config: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg === '-v' || arg === '--version') {
      flags.version = true;
    } else if (arg === '--strict') {
      flags.strict = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--config') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        return { error: 'Option --config requires a file path' };
      }
      flags.config = next;
      i += 1;
    } else if (arg.startsWith('--config=')) {
      flags.config = arg.slice('--config='.length);
    } else if (arg.startsWith('-')) {
      return { error: `Unknown option: ${arg}` };
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function formatTextReport(report) {
  const lines = [];
  const headerTarget = report.configFile
    ? `${report.projectDir} (${report.configFile})`
    : report.projectDir;
  lines.push(`cfdoctor preflight: ${headerTarget}`);

  if (report.findings.length === 0) {
    lines.push('Status: PASS (0 errors, 0 warnings)');
    return lines.join('\n');
  }

  for (const f of report.findings) {
    const tag = f.severity === 'error' ? 'ERROR' : 'WARN ';
    lines.push(`  [${tag}] ${f.code}: ${f.message}`);
  }

  const statusLabel = report.ok ? 'PASS' : 'FAIL';
  lines.push(
    `Status: ${statusLabel} (${report.summary.errors} error(s), ${report.summary.warnings} warning(s)${report.strict ? ', strict mode' : ''})`
  );
  return lines.join('\n');
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((msg) => process.stdout.write(`${msg}\n`));
  const stderr = io.stderr ?? ((msg) => process.stderr.write(`${msg}\n`));

  const parsed = parseCliArgs(argv);
  if (parsed.error) {
    stderr(`Error: ${parsed.error}\nRun "cfdoctor --help" for usage.`);
    return 1;
  }

  const { positional, flags } = parsed;

  if (flags.version) {
    stdout(VERSION);
    return 0;
  }

  if (flags.help || positional.length === 0) {
    if (positional.length === 0 && !flags.help && (flags.json || flags.strict || flags.config)) {
      // Allow `cfdoctor --json` to default to checking `.`
      positional.push('check', '.');
    } else {
      stdout(HELP_TEXT.trimEnd());
      return 0;
    }
  }

  const subcommand = positional[0];
  if (subcommand !== 'check') {
    stderr(`Error: Unknown command "${subcommand}". Expected "cfdoctor check [projectDir]".`);
    return 1;
  }

  const projectDir = positional[1] ?? '.';
  const report = auditProject(projectDir, {
    strict: flags.strict,
    config: flags.config,
  });

  if (flags.json) {
    stdout(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    stdout(formatTextReport(report));
  } else {
    stderr(formatTextReport(report));
  }

  return report.exitCode;
}
