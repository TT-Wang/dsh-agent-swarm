#!/usr/bin/env node
/**
 * R17-G10 operational sweep: apply the declared payload-spill bound to one
 * `trace-payloads` directory (usually `dirname(statePath)/trace-payloads`) and
 * report exactly what was reclaimed.
 *
 * The plugin itself sweeps at every host start (`TraceRecorder.startupSweep`),
 * so this script exists for the two cases a restart cannot cover: measuring a
 * leaked directory that is already on disk (`--dry-run` changes nothing and
 * prints the same counts a real sweep would produce), and reclaiming that
 * directory now instead of at the next start. It shares the plugin's one sweep
 * implementation, so the CLI and the runtime cannot disagree about the bound.
 *
 * Usage:
 *   node scripts/sweep-trace-payloads.mjs --root <trace-payloads dir> [--dry-run]
 *     [--max-bytes N] [--max-files N] [--retention-days N]
 *
 * Reads the built module, so run `npm run build` first (the declared checks
 * always do).
 *
 * Exit status: 0 when the sweep (or dry run) completed, 1 on a usage error or a
 * contained filesystem error reported by the sweep.
 */
import { sweepTraceSpill, DEFAULT_TRACE_SPILL_LIMITS } from '../lib/trace.js'

const USAGE = 'usage: node scripts/sweep-trace-payloads.mjs --root <trace-payloads dir> [--dry-run] [--max-bytes N] [--max-files N] [--retention-days N]'

function parseArguments(argv) {
  const options = { root: undefined, dryRun: false, limits: {} }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--dry-run') { options.dryRun = true; continue }
    const value = argv[++index]
    if (value === undefined) throw new Error(`missing value for ${argument}; ${USAGE}`)
    if (argument === '--root') options.root = value
    else if (argument === '--max-bytes') options.limits.maxBytes = Number(value)
    else if (argument === '--max-files') options.limits.maxFiles = Number(value)
    else if (argument === '--retention-days') options.limits.retentionMs = Number(value) * 24 * 60 * 60 * 1000
    else throw new Error(`unknown argument ${argument}; ${USAGE}`)
  }
  if (typeof options.root !== 'string' || !options.root) throw new Error(`--root is required; ${USAGE}`)
  for (const [name, value] of Object.entries(options.limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`)
  }
  return options
}

const options = parseArguments(process.argv.slice(2))
const limits = { ...DEFAULT_TRACE_SPILL_LIMITS, ...options.limits }
const warnings = []
const report = await sweepTraceSpill({
  root: options.root,
  limits: options.limits,
  dryRun: options.dryRun,
  warn: message => { warnings.push(message); process.stderr.write(`warn: ${message}\n`) },
})

process.stdout.write(`${JSON.stringify({
  root: report.root,
  dryRun: report.dryRun,
  at: new Date(report.now).toISOString(),
  bound: { maxBytes: limits.maxBytes, maxFiles: limits.maxFiles, retentionDays: limits.retentionMs / (24 * 60 * 60 * 1000) },
  scanned: report.scanned,
  before: { files: report.files, bytes: report.bytes },
  reclaimed: { expired: report.expired, evicted: report.evicted, deleted: report.deleted, bytes: report.bytesDeleted },
  after: { files: report.filesAfter, bytes: report.bytesAfter },
  skipped: report.skipped,
  errors: report.errors,
}, null, 2)}\n`)
process.stdout.write(`${report.dryRun ? 'DRY RUN' : 'SWEPT'} ${report.root}: ${report.files} files / ${report.bytes} B -> ${report.filesAfter} files / ${report.bytesAfter} B (expired ${report.expired}, evicted ${report.evicted}, skipped ${report.skipped}, errors ${report.errors.length})\n`)
process.exitCode = report.errors.length === 0 ? 0 : 1
