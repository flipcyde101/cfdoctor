# cfdoctor

Zero-dependency Node 24 ESM preflight auditor for Cloudflare Workers and Pages configurations (`wrangler.jsonc`, `wrangler.json`, and `wrangler.toml`).

## Requirements

- Node.js >= 24.0.0

## Usage

```bash
node ./bin/cfdoctor.js check [projectDir] [--strict] [--json] [--config <file>]
```

On Windows PowerShell:

```powershell
npm.cmd test
node .\bin\cfdoctor.js check .\my-worker --strict
```

## Preflight Checks

1. **Entrypoint and Bundle Size**: Verifies `main` (or `pages_build_output_dir` / `assets.directory`) exists on disk, checks non-empty entrypoint, and flags source bundles exceeding Cloudflare Workers size thresholds (3 MiB Free warning, 10 MiB error).
2. **Runtime Compatibility**: Checks `compatibility_date` presence and ISO format, warns on dates older than `2024-09-23`, and errors when `node:*` built-in imports appear in source without `nodejs_compat` in `compatibility_flags`.
3. **Binding Integrity**: Detects duplicate binding names across `kv_namespaces`, `d1_databases`, `r2_buckets`, `queues`, `durable_objects`, `services`, `ai`, and `vars`, plus empty or placeholder IDs (`TODO`, `xxxx`, all-zero IDs, empty `id`/`database_id`).
4. **Cron Triggers**: Validates 5-field cron syntax across `triggers.crons`.
5. **Secret Hygiene**: Compares `.dev.vars.example` and referenced `env.<SECRET>` keys against `.dev.vars` without ever printing secret values, and verifies `.gitignore` excludes `.dev.vars` and `.wrangler`.

## Exit Codes

- `0`: Preflight passed
- `1`: Invalid CLI arguments
- `2`: Hard errors found (or warnings when `--strict` is enabled)

## License

MIT
