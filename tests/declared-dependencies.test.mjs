/**
 * T2: the dependency manifest is complete, so `npm ci` from package-lock.json
 * is the whole dependency source of the hermetic tier (scripts/test-tiers.mjs)
 * and a fresh clone runs it without a Harness checkout.
 *
 * The 2026-10-22 self-review found jsdom borrowed from the Harness checkout and
 * eight Harness packages imported by tests but declared nowhere: they resolved
 * only because a link farm provided the whole checkout. Here every package
 * that src/, tests/ or scripts/ imports by a bare specifier, for a value or a
 * type, must be a devDependency at one exact version, every package src imports
 * must also be a peer (the host provides it at run time), and the committed
 * lockfile must declare exactly those and resolve every dsh-* package to the
 * one supported release.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const PROJECT = fileURLToPath(new URL('..', import.meta.url))
const read = path => JSON.parse(readFileSync(join(PROJECT, path), 'utf8'))
const manifest = read('package.json')

/** The package a bare specifier names, or undefined for a relative path, a URL or a Node builtin. */
function packageOf(specifier) {
  if (/^[./]/.test(specifier) || /^[a-z]+:/.test(specifier)) return undefined
  const segments = specifier.split('/')
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  return builtinModules.includes(name) ? undefined : name
}

/** Each package imported under `directory`, with the files that import it. */
function importedPackages(directory) {
  const packages = new Map()
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (/\.(?:mjs|js|ts|tsx)$/.test(entry.name)) {
        for (const { fileName } of ts.preProcessFile(readFileSync(child, 'utf8'), true, true).importedFiles) {
          const name = packageOf(fileName)
          if (name === undefined) continue
          if (!packages.has(name)) packages.set(name, [])
          packages.get(name).push(relative(PROJECT, child))
        }
      }
    }
  }
  walk(join(PROJECT, directory))
  return packages
}

test('a bare specifier names its package; relative paths, URLs and Node builtins name none', () => {
  assert.equal(packageOf('@deepseek-ai/dsh-session/types'), '@deepseek-ai/dsh-session')
  assert.equal(packageOf('react-dom/client'), 'react-dom')
  assert.equal(packageOf('jsdom'), 'jsdom')
  for (const local of ['./x.mjs', '../lib/runtime.js', '/abs/path.mjs', 'node:fs', 'fs', 'child_process', 'file:///x.mjs']) assert.equal(packageOf(local), undefined, local)
})

test('every package src, tests and scripts import is a devDependency pinned to one version', () => {
  const undeclared = [], ranged = []
  for (const directory of ['src', 'tests', 'scripts']) {
    for (const [name, files] of importedPackages(directory)) {
      const version = manifest.devDependencies?.[name]
      if (version === undefined) undeclared.push(`${name} (${files[0]})`)
      else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) ranged.push(`${name}@${version}`)
    }
  }
  assert.deepEqual(undeclared, [], 'npm ci installs only declared packages; declare each in devDependencies')
  assert.deepEqual(ranged, [], 'a devDependency names the exact version its lockfile entry holds')
  assert.ok(importedPackages('tests').has('jsdom'), 'the scan sees the UI tests\' own jsdom import')
})

test('every package src imports is a peer dependency, the host\'s to provide', () => {
  const missing = [...importedPackages('src')].filter(([name]) => manifest.peerDependencies?.[name] === undefined).map(([name, files]) => `${name} (${files[0]})`)
  assert.deepEqual(missing, [])
})

test('the committed lockfile declares exactly package.json\'s dependencies and resolves every dsh-* package to the supported release', () => {
  const lock = read('package-lock.json')
  const [{ version: release }] = read('compatibility.json').supportedHosts
  const root = lock.packages['']
  assert.equal(lock.lockfileVersion, 3)
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    assert.deepEqual(root[field] ?? {}, manifest[field] ?? {}, `package-lock.json ${field} must match package.json; run npm install --package-lock-only`)
  }
  const offRelease = [], unpinned = []
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue
    if (!entry.link && (typeof entry.integrity !== 'string' || !entry.resolved?.startsWith('https://registry.npmjs.org/'))) unpinned.push(path)
    if (/(?:^|\/)node_modules\/@deepseek-ai\/dsh-[^/]+$/.test(path) && entry.version !== release) offRelease.push(`${path}@${entry.version}`)
  }
  assert.deepEqual(unpinned, [], 'every locked package comes from the npm registry with an integrity hash')
  assert.deepEqual(offRelease, [], `every Harness package resolves to ${release}`)
})
