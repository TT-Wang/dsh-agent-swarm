/**
 * Real Harness Loader composition for the provider-fault tier (F3a/F3b/F3c).
 *
 * Adapted from `tests/fixtures/built-harness.mjs` (same boot protocol: real
 * Loader, real Include parsing, every entry must activate) but self-contained
 * and with two environment substitutions documented in `identity-sandbox.mjs`:
 * an identity `sandbox` provider and an unsandboxed `bash-local` shell,
 * because this host refuses `sandbox-exec`.
 */
import assert from 'node:assert/strict'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PROJECT } from './harness.mjs'

const catalogs = new Map()

export function resolveHarnessRoot(explicit) {
  const candidates = [
    explicit, process.env.DSH_HARNESS_ROOT, process.env.DSH_SOURCE,
    join(homedir(), '.dsh/source/current'),
    resolve(PROJECT, '../deepseek-harness-rc1'),
    resolve(PROJECT, '../deepseek-harness-latest'),
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(join(candidate, 'package.json'))) return resolve(candidate)
  throw new Error('The fault suite needs a built Harness checkout; set DSH_HARNESS_ROOT (see compatibility.json)')
}

export async function harnessCatalog(root) {
  root = resolve(root)
  if (catalogs.has(root)) return catalogs.get(root)
  const packages = new Map()
  const add = async directory => {
    let manifest
    try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (manifest.name) packages.set(manifest.name, { directory, manifest })
  }
  for (const entry of await readdir(join(root, 'vendor'), { withFileTypes: true })) if (entry.isDirectory()) await add(join(root, 'vendor', entry.name))
  for (const group of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const entry of await readdir(join(root, 'packages', group.name), { withFileTypes: true })) if (entry.isDirectory()) await add(join(root, 'packages', group.name, entry.name))
  }
  catalogs.set(root, packages)
  return packages
}

export async function harnessEntry(root, name) {
  const entry = (await harnessCatalog(root)).get(name)
  assert(entry, `Harness package is absent: ${name}`)
  const main = entry.manifest.exports?.['.']?.default ?? entry.manifest.main
  assert.equal(typeof main, 'string', `Harness has no built entry for ${name}`)
  const target = join(entry.directory, main)
  await access(target)
  assert(target.includes('/lib/'), `Harness entry must be built: ${target}`)
  return pathToFileURL(target).href
}

export async function importHarness(root, name) { return await import(await harnessEntry(root, name)) }

/** Boot the real Loader with the fault provider and the identity sandbox. */
export async function bootFaultHarness({ runRoot, workspace, harnessRoot, swarmConfig, artifactRoot = PROJECT }) {
  harnessRoot = resolveHarnessRoot(harnessRoot)
  const { Context } = await importHarness(harnessRoot, '@deepseek-ai/cordis')
  const { default: Loader } = await importHarness(harnessRoot, '@deepseek-ai/cordis-plugin-loader')
  const { default: Include } = await importHarness(harnessRoot, '@deepseek-ai/cordis-plugin-include')
  const manifest = JSON.parse(await readFile(join(artifactRoot, 'package.json'), 'utf8'))
  const builtEntry = manifest.exports?.['.']?.default ?? manifest.main
  assert.equal(typeof builtEntry, 'string', 'the swarm package must publish a built ESM entry')
  const plugins = [
    ['llm', '@deepseek-ai/dsh-llm'],
    ['sessions', '@deepseek-ai/dsh-session'],
    ['session-projections', '@deepseek-ai/dsh-session-projection'],
    ['system-prompt', '@deepseek-ai/dsh-system-prompt', { includeRuntimeContext: false }],
    ['tools', '@deepseek-ai/dsh-tools'],
    ['agents', '@deepseek-ai/dsh-agent'],
    ['persistence', '@deepseek-ai/dsh-session-persistence-jsonl', { root: join(runRoot, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 }],
    ['subprocess', '@deepseek-ai/dsh-subprocess-local'],
    ['sandbox-policy', '@deepseek-ai/dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: workspace }],
    ['approval', '@deepseek-ai/dsh-user-approval', { policy: 'never' }],
    ['shell', '@deepseek-ai/dsh-bash-local', { cwd: workspace, timeoutMs: 10_000, graceMs: 50 }],
    ['shell-env', '@deepseek-ai/dsh-shell-env', { dshHome: join(runRoot, 'dsh-home') }],
    ['tool-bash', '@deepseek-ai/dsh-tool-bash', { enableRunInBackground: false }],
    ['agent-loop', '@deepseek-ai/dsh-agent-loop', { agents: [] }],
  ]
  const entries = await Promise.all(plugins.map(async ([id, name, config]) => ({ id, name: await harnessEntry(harnessRoot, name), ...(config ? { config } : {}) })))
  entries.push({ id: 'faults-identity-sandbox', name: new URL('./identity-sandbox.mjs', import.meta.url).href })
  entries.push({ id: 'faults-scripted-llm', name: new URL('./scripted-provider.mjs', import.meta.url).href, config: { harnessRoot } })
  entries.push({ id: 'swarm', name: pathToFileURL(join(artifactRoot, builtEntry)).href, config: swarmConfig })
  await mkdir(runRoot, { recursive: true })
  const configPath = join(runRoot, 'faults.cordis.yml')
  // JSON is a YAML subset, so the real Include parser sees exactly these values.
  await writeFile(configPath, JSON.stringify(entries, null, 2) + '\n')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(runRoot).href + '/'
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const pending = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled).map(entry => entry.options.id)
    assert.deepEqual(pending, [], 'every real Loader entry must activate')
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

/** Owner actor for direct runtime calls; the worker sessions are real agents. */
export const FAULT_OWNER = { sessionId: 'fault-owner' }
