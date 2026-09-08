import assert from 'node:assert/strict'
import { access, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const catalogs = new Map()

/** Locate published entries; this fixture never redirects Harness imports to source. */
export async function harnessCatalog(root) {
  root = resolve(root)
  if (catalogs.has(root)) return catalogs.get(root)
  const packages = new Map()
  async function add(directory) {
    let manifest
    try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (manifest.name) packages.set(manifest.name, { directory, manifest })
  }
  for (const directory of await readdir(join(root, 'vendor'), { withFileTypes: true })) {
    if (directory.isDirectory()) await add(join(root, 'vendor', directory.name))
  }
  for (const group of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const directory of await readdir(join(root, 'packages', group.name), { withFileTypes: true })) {
      if (directory.isDirectory()) await add(join(root, 'packages', group.name, directory.name))
    }
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

export async function importHarness(root, name) {
  return import(await harnessEntry(root, name))
}

/** An extracted npm artifact resolves peers from one already-built Harness installation. */
export async function linkHarnessPeers(packageRoot, harnessRoot) {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const catalog = await harnessCatalog(harnessRoot)
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    if (!name.startsWith('@deepseek-ai/')) continue
    const entry = catalog.get(name)
    assert(entry, `Declared Harness dependency is unavailable: ${name}`)
    const { directory } = entry
    const destination = join(packageRoot, 'node_modules', name)
    await mkdir(dirname(destination), { recursive: true })
    try { await symlink(directory, destination, 'dir') }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
}

export async function bootHarness({ harnessRoot, artifactRoot, runRoot, workspace, swarmConfig, bundleProfile, deepseekConfig, shellConfig }) {
  const { Context } = await importHarness(harnessRoot, '@deepseek-ai/cordis')
  const { default: Loader } = await importHarness(harnessRoot, '@deepseek-ai/cordis-plugin-loader')
  const { default: Include } = await importHarness(harnessRoot, '@deepseek-ai/cordis-plugin-include')
  const manifest = JSON.parse(await readFile(join(artifactRoot, 'package.json'), 'utf8'))
  const builtEntry = manifest.exports?.['.']?.default ?? manifest.exports?.['.']?.import ?? manifest.main
  assert.equal(typeof builtEntry, 'string', 'Swarm package must publish an ESM entry')
  const plugins = [
    ['llm', '@deepseek-ai/dsh-llm'],
    ['sessions', '@deepseek-ai/dsh-session'],
    ['session-projections', '@deepseek-ai/dsh-session-projection'],
    ['system-prompt', '@deepseek-ai/dsh-system-prompt', { includeRuntimeContext: false }],
    ['tools', '@deepseek-ai/dsh-tools'],
    ['agents', '@deepseek-ai/dsh-agent'],
    ['persistence', '@deepseek-ai/dsh-session-persistence-jsonl', {
      root: join(runRoot, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1,
    }],
    ['subprocess', '@deepseek-ai/dsh-subprocess-local'],
    ['sandbox', '@deepseek-ai/dsh-sandbox-local'],
    ['sandbox-policy', '@deepseek-ai/dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: workspace }],
    ['approval', '@deepseek-ai/dsh-user-approval', { policy: 'never' }],
    ['shell', '@deepseek-ai/dsh-bash-sandbox', { cwd: workspace, timeoutMs: 5000, graceMs: 50, ...shellConfig }],
    ['shell-env', '@deepseek-ai/dsh-shell-env', { dshHome: join(runRoot, 'dsh-home') }],
    ['tool-bash', '@deepseek-ai/dsh-tool-bash', { enableRunInBackground: false }],
    ['agent-loop', '@deepseek-ai/dsh-agent-loop', { agents: [] }],
  ]
  const entries = await Promise.all(plugins.map(async ([id, name, config]) => ({
    id, name: await harnessEntry(harnessRoot, name), ...(config ? { config } : {}),
  })))
  entries.push(deepseekConfig ? {
    id: 'deepseek-llm', name: await harnessEntry(harnessRoot, '@deepseek-ai/dsh-llm-deepseek'),
    config: deepseekConfig,
  } : {
    id: 'scripted-llm', name: new URL('./scripted-llm.mjs', import.meta.url).href,
    config: { harnessRoot },
  })
  let patches
  if (bundleProfile) {
    const { loadProfile, composeEntries } = await importHarness(harnessRoot, '@deepseek-ai/dsh-app-boot')
    const profile = loadProfile('swarm-profile-smoke', basename(bundleProfile), join(harnessRoot, 'apps/cli/package.json'), dirname(dirname(bundleProfile)))
    const layer = profile.layers.find(layer => layer.packageName === manifest.name)
    assert(layer, 'the CLI-installed swarm bundle must be reconciled into the profile')
    const rows = composeEntries([layer.patches])
    const swarmRow = rows.find(row => row.name === manifest.name)
    assert(swarmRow, 'the actual installed cordis.patch.yml must add the swarm runtime')
    patches = [...layer.patches, { id: swarmRow.id, config: swarmConfig }]
  } else {
    entries.push({ id: 'swarm', name: pathToFileURL(join(artifactRoot, builtEntry)).href, config: swarmConfig })
  }
  await mkdir(runRoot, { recursive: true })
  const configPath = bundleProfile ? join(bundleProfile, 'smoke-fixture.cordis.yml') : join(runRoot, 'cordis.yml')
  // JSON is a YAML subset: preserve config values exactly through the actual Include parser.
  await writeFile(configPath, JSON.stringify(entries, null, 2) + '\n')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(runRoot).href + '/'
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href, ...(patches ? { patches } : {}) } })
    await ctx.loader.await()
    const pending = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.id)
    assert.deepEqual(pending, [], 'all real Loader entries must activate')
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
