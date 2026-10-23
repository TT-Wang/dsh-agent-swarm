/**
 * Overlay a built Harness checkout onto node_modules, so the plugin, its tests
 * and the host-tier gates run on the host's own module instances.
 *
 * node_modules has one base: what `npm ci` installs from package-lock.json, or
 * nothing at all when this script builds a link farm alone. Over that base it
 *
 * - links every @deepseek-ai package the checkout provides, replacing whatever
 *   is installed under that name: an earlier link, or a copy npm installed,
 *   which must be the version the checkout has (the lockfile and the checkout
 *   then name one release, so the swap changes the instance, not the code);
 * - removes links to checkout packages that no longer exist;
 * - keeps every other devDependency npm installed (the lockfile owns compilers,
 *   types, React and jsdom), and links the checkout's copy, with its bins, only
 *   where npm installed none; that copy must be the version package.json pins.
 *
 * Every conflict is reported before node_modules is touched, and a declared
 * package it can neither keep nor link is a conflict: nothing is skipped silently.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSupportedHarness, resolveHarnessRoot } from './harness-target.mjs'

const readManifest = path => JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))

/** 'link', 'copy' or undefined: what node_modules holds at `path`. */
function holding(path) {
  try { return lstatSync(path).isSymbolicLink() ? 'link' : 'copy' }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

/** Every @deepseek-ai package the checkout provides, by name. */
export function harnessPackages(harness) {
  const packages = new Map()
  const roots = ['vendor', 'apps', ...readdirSync(join(harness, 'packages'), { withFileTypes: true }).filter(group => group.isDirectory()).map(group => `packages/${group.name}`)]
  for (const root of roots) {
    if (!existsSync(join(harness, root))) continue
    for (const leaf of readdirSync(join(harness, root), { withFileTypes: true })) {
      if (!leaf.isDirectory()) continue
      const path = join(harness, root, leaf.name)
      if (!existsSync(join(path, 'package.json'))) continue
      const { name } = readManifest(path)
      if (!name?.startsWith('@deepseek-ai/')) continue
      if (packages.has(name)) throw new Error(`Duplicate Harness package ${name}`)
      packages.set(name, path)
    }
  }
  return packages
}

function isHarnessLink(path) {
  let directory
  try { directory = realpathSync(path) } catch { return false }
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'package.json')) && readManifest(directory).name === '@deepseek-ai/dsh-root') return true
    directory = dirname(directory)
  }
  return false
}

/** The bins a package declares, as { name: path within the package }. */
function binsOf(manifest) {
  if (typeof manifest.bin === 'string') return { [manifest.name.split('/').pop()]: manifest.bin }
  return manifest.bin ?? {}
}

/**
 * Link `harness` into `repo`/node_modules as described above. Returns what it
 * did: how many packages it linked, which of them replaced a copy npm installed,
 * which other devDependencies it linked from the checkout and which it kept.
 */
export function linkHarness(repo, harness) {
  const modules = join(repo, 'node_modules')
  const packages = harnessPackages(harness)
  const conflicts = []
  const replaced = []
  for (const [name, path] of packages) {
    const destination = join(modules, name)
    if (holding(destination) !== 'copy') continue
    const [installed, provided] = [readManifest(destination).version, readManifest(path).version]
    if (installed === provided) replaced.push(name)
    else conflicts.push(`${name}: npm installed ${installed}, the checkout has ${provided}`)
  }
  const tools = [], kept = []
  for (const [name, version] of Object.entries(readManifest(repo).devDependencies ?? {})) {
    if (packages.has(name)) continue
    if (holding(join(modules, name)) === 'copy') { kept.push(name); continue }
    const source = name.startsWith('@deepseek-ai/') ? undefined
      : ['node_modules', 'packages/client/web/node_modules', 'packages/client/ui-conversation/node_modules'].map(base => join(harness, base, name)).find(path => existsSync(join(path, 'package.json')))
    if (source === undefined) { conflicts.push(`${name}: declared in devDependencies, but npm installed none and the checkout has none`); continue }
    const provided = readManifest(source).version
    if (provided !== version) { conflicts.push(`${name}: package.json pins ${version}, the checkout has ${provided}`); continue }
    for (const bin of Object.keys(binsOf(readManifest(source)))) {
      if (holding(join(modules, '.bin', bin)) === 'copy') conflicts.push(`${name}: node_modules/.bin/${bin} is a file, not a link`)
    }
    tools.push([name, source])
  }
  if (conflicts.length) throw new Error(`Cannot link the Harness checkout ${harness} into ${modules}; nothing was changed:\n  ${conflicts.join('\n  ')}`)

  // Links to checkout packages that no longer exist must not mask removed APIs; unrelated manual links stay.
  const namespace = join(modules, '@deepseek-ai')
  if (existsSync(namespace)) for (const leaf of readdirSync(namespace)) {
    const destination = join(namespace, leaf)
    if (holding(destination) === 'link' && (packages.has(`@deepseek-ai/${leaf}`) || isHarnessLink(destination))) unlinkSync(destination)
  }
  for (const [name, path] of packages) {
    const destination = join(modules, name)
    if (replaced.includes(name)) rmSync(destination, { recursive: true, force: true })
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(path, destination, 'dir')
  }
  for (const [name, source] of tools) {
    const destination = join(modules, name)
    if (holding(destination) === 'link') unlinkSync(destination)
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(source, destination, 'dir')
    for (const [bin, path] of Object.entries(binsOf(readManifest(source)))) {
      const link = join(modules, '.bin', bin)
      mkdirSync(dirname(link), { recursive: true })
      if (holding(link) === 'link') unlinkSync(link)
      symlinkSync(relative(dirname(link), join(destination, path)), link)
    }
  }
  return { linked: packages.size, replaced, tools: tools.map(([name]) => name), kept }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const harness = resolveHarnessRoot()
  assertSupportedHarness(harness)
  const { linked, replaced, tools, kept } = linkHarness(repo, harness)
  process.stdout.write(`Linked local Harness: ${harness}\n`)
  process.stdout.write(`  ${linked} @deepseek-ai packages linked to the checkout${replaced.length ? `, ${replaced.length} of them in place of the copies npm installed` : ''}\n`)
  if (tools.length) process.stdout.write(`  linked from the checkout, as npm installed none: ${tools.join(', ')}\n`)
  if (kept.length) process.stdout.write(`  kept as npm installed them: ${kept.join(', ')}\n`)
}
