import { readdirSync, readFileSync, existsSync, mkdirSync, lstatSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = resolveHarnessRoot()
assertSupportedHarness(harness)
const namespace = join(repo, 'node_modules/@deepseek-ai')
const packages = new Map()
const roots = ['vendor', 'apps', ...readdirSync(join(harness, 'packages'), { withFileTypes: true }).filter(g => g.isDirectory()).map(g => `packages/${g.name}`)]
for (const root of roots) {
  for (const leaf of readdirSync(join(harness, root), { withFileTypes: true })) {
    if (!leaf.isDirectory()) continue
    const path = join(harness, root, leaf.name)
    if (!existsSync(join(path, 'package.json'))) continue
    const { name } = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
    if (!name?.startsWith('@deepseek-ai/')) continue
    if (packages.has(name)) throw new Error(`Duplicate Harness package ${name}`)
    packages.set(name, path)
  }
}
// Validate all conflicts before touching a working development installation.
for (const name of packages.keys()) {
  const dest = join(repo, 'node_modules', name)
  try { if (!lstatSync(dest).isSymbolicLink()) throw new Error(`Refusing to replace installed package ${dest}`) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
function isHarnessLink(path) {
  let directory
  try { directory = realpathSync(path) } catch { return false }
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh-root') return true
    directory = dirname(directory)
  }
  return false
}
// Retired SDK links must not mask removed APIs; preserve unrelated manual links.
if (existsSync(namespace)) for (const leaf of readdirSync(namespace)) {
  const dest = join(namespace, leaf)
  if (lstatSync(dest).isSymbolicLink() && (packages.has(`@deepseek-ai/${leaf}`) || isHarnessLink(dest))) unlinkSync(dest)
}
for (const [name, path] of packages) {
  const dest = join(repo, 'node_modules', name)
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(path, dest, 'dir')
}
for (const name of ['typescript', '@types/node', 'react', 'react-dom', '@types/react', '@types/react-dom', 'esbuild', 'tsdown']) {
  const source = [join(harness, 'node_modules', name), join(harness, 'packages/client/web/node_modules', name), join(harness, 'packages/client/ui-conversation/node_modules', name)].find(p => existsSync(p))
  const dest = join(repo, 'node_modules', name)
  if (source === undefined) continue
  try { if (lstatSync(dest).isSymbolicLink()) unlinkSync(dest); else continue }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(source, dest, 'dir')
}
mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true })
for (const name of ['tsc', 'esbuild']) {
  const dest = join(repo, 'node_modules/.bin', name)
  const source = join(harness, 'node_modules/.bin', name)
  if (!existsSync(source)) continue
  try { if (lstatSync(dest).isSymbolicLink()) unlinkSync(dest); else continue } catch (error) { if (error.code !== 'ENOENT') throw error }
  symlinkSync(source, dest)
}
process.stdout.write(`Linked local Harness: ${harness}\n`)
