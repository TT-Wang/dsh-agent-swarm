/**
 * Real Harness Loader composition for the provider-fault tier (F3a/F3b/F3c).
 *
 * Adapted from `tests/fixtures/built-harness.mjs` (same boot protocol: real
 * Loader, real Include parsing, every entry must activate), sharing its package
 * catalog, its activation check and the host-provided rows `bash` needs, with
 * two environment substitutions documented in `identity-sandbox.mjs`: an
 * identity `sandbox` provider and an unsandboxed `bash-local` shell, because
 * this host refuses `sandbox-exec`.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROJECT } from './harness.mjs'
import { NamedHarnessRootError, assertSupportedHarness, resolveHarnessRoot as resolveTarget } from '../../scripts/harness-target.mjs'
import { assertEveryEntryActive, harnessEntry, importHarness, workingDirectoryRows } from '../fixtures/built-harness.mjs'

/**
 * The release gates' own selection (scripts/harness-target.mjs), with the fault
 * suite's message, and their support check: an explicitly supplied checkout of
 * a release outside compatibility.json is refused, never booted. The generic
 * message is for an empty default search only; a supplied root that cannot be
 * used (a missing path, say) reports its own cause.
 */
export function resolveHarnessRoot(explicit) {
  let root
  try { root = resolveTarget(explicit) } catch (error) {
    if (error instanceof NamedHarnessRootError) throw new Error(`The fault suite cannot use the Harness checkout ${error.named}: ${error.message}`, { cause: error })
    throw new Error('The fault suite needs a built Harness checkout; set DSH_HARNESS_ROOT (see compatibility.json)')
  }
  assertSupportedHarness(root)
  return root
}

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
    ...workingDirectoryRows(workspace),
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
    assertEveryEntryActive(ctx.loader, 'every real Loader entry must activate')
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

/** Owner actor for direct runtime calls; the worker sessions are real agents. */
export const FAULT_OWNER = { sessionId: 'fault-owner' }
