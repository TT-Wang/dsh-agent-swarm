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
 *
 * The typecheck reads more than the plugin imports: the declarations of every
 * package it imports, and every package those declarations import. The Harness
 * client packages' declarations import packages that are only their own
 * devDependencies, which npm does not install with them
 * (dsh-client-ui-model-selection's import dsh-client-store and dsh-api-remotes).
 * Under skipLibCheck an import that resolves to nothing is no error: the store
 * snapshot became `unknown` and ui-session's augmentation of `sessions` was
 * lost, so the typecheck that passed on a link farm failed in CI's fresh clone
 * (2026-10-24). Here every package the typecheck's programs import, from any
 * file they read, must be one the lockfile installs where that file's package
 * finds it, so the typecheck reads the same declarations from `npm ci` as from
 * the host.
 *
 * The same holds for code. The client packages import at run time packages
 * that are only their devDependencies, because the host's web build bundles
 * them: dsh-client-ui-primitives imports shiki, katex, micromark and clsx, and
 * dsh-client-store zustand and immer. The UI tests evaluate the real client
 * bundles, which load them, so they failed in a fresh clone with
 * ERR_MODULE_NOT_FOUND. Here every package the JavaScript of an installed
 * Harness package imports must be one the lockfile installs where that package
 * finds it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const PROJECT = fileURLToPath(new URL('..', import.meta.url))
const read = path => JSON.parse(readFileSync(join(PROJECT, path), 'utf8'))
const manifest = read('package.json')
const lock = read('package-lock.json')

/** The package a bare specifier names, or undefined for a relative path, a URL or a Node builtin. */
function packageOf(specifier) {
  if (/^[./#]/.test(specifier) || /^[a-z]+:/.test(specifier)) return undefined
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

/** The package DefinitelyTyped publishes the types of `name` as. */
const typesPackage = name => `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`

/** Whether `specifier` names a file TypeScript reads no types from, such as a stylesheet: only code and JSON resolve. */
const isAsset = (specifier, name) => /\.(?!(?:[cm]?[jt]sx?|json)$)[^./]+$/.test(specifier.slice(name.length))

/**
 * Every import the typecheck's programs (tsconfig.json and tsconfig.client.json)
 * resolve, from every file they read, the packages' declarations included, and
 * every types package they name: [{ file, specifier }]. The compiler's own
 * resolution, recorded as it goes, so module augmentations and import types count.
 */
function typecheckImports() {
  const imports = []
  for (const config of ['tsconfig.json', 'tsconfig.client.json']) {
    const parsed = ts.getParsedCommandLineOfConfigFile(join(PROJECT, config), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) } })
    const host = ts.createCompilerHost(parsed.options)
    const cache = ts.createModuleResolutionCache(PROJECT, name => host.getCanonicalFileName(name), parsed.options)
    host.resolveModuleNameLiterals = (literals, file, redirected, options, sourceFile) => literals.map(literal => {
      imports.push({ file, specifier: literal.text })
      return ts.resolveModuleName(literal.text, file, options, host, cache, redirected, ts.getModeForUsageLocation(sourceFile, literal, options))
    })
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host })
    for (const name of parsed.options.types ?? []) imports.push({ file: join(PROJECT, config), specifier: name })
    for (const sourceFile of program.getSourceFiles()) {
      for (const { fileName } of sourceFile.typeReferenceDirectives) imports.push({ file: sourceFile.fileName, specifier: fileName })
    }
  }
  return imports
}

/** The name of the package `file` belongs to: the nearest package.json above it that has one. */
const packageNames = new Map()
function packageAt(file) {
  const directory = dirname(file)
  if (!packageNames.has(directory)) {
    const path = join(directory, 'package.json')
    const name = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).name : undefined
    packageNames.set(directory, typeof name === 'string' ? name : dirname(directory) === directory ? undefined : packageAt(directory))
  }
  return packageNames.get(directory)
}

/** The lockfile paths `npm ci` installs `name` at: '' for this package. */
const installedAt = name => name === manifest.name ? [''] : Object.keys(lock.packages).filter(path => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))

/** Whether `npm ci` installs `name` where Node and TypeScript find it from the package installed at `from`. */
function visibleFrom(from, name) {
  for (let base = from; ; base = base.lastIndexOf('/node_modules/') === -1 ? '' : base.slice(0, base.lastIndexOf('/node_modules/'))) {
    if (Object.hasOwn(lock.packages, `${base ? `${base}/` : ''}node_modules/${name}`)) return true
    if (base === '') return false
  }
}

test('a bare specifier names its package; relative paths, URLs and Node builtins name none', () => {
  assert.equal(packageOf('@deepseek-ai/dsh-session/types'), '@deepseek-ai/dsh-session')
  assert.equal(packageOf('react-dom/client'), 'react-dom')
  assert.equal(packageOf('jsdom'), 'jsdom')
  for (const local of ['./x.mjs', '../lib/runtime.js', '/abs/path.mjs', '#internal/x', 'node:fs', 'fs', 'child_process', 'file:///x.mjs']) assert.equal(packageOf(local), undefined, local)
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

test('the typecheck census names packages as Node, TypeScript and DefinitelyTyped do, and finds them where npm ci installs them', () => {
  assert.equal(typesPackage('mdast'), '@types/mdast')
  assert.equal(typesPackage('@scope/name'), '@types/scope__name')
  assert.equal(isAsset('katex/dist/katex.min.css', 'katex'), true)
  for (const [specifier, name] of [['@deepseek-ai/dsh-api-remotes/client', '@deepseek-ai/dsh-api-remotes'], ['react', 'react'], ['dayjs/plugin/utc.js', 'dayjs'], ['x/types.d.mts', 'x'], ['x/data.json', 'x'], ['socket.io', 'socket.io']]) assert.equal(isAsset(specifier, name), false, specifier)
  assert.equal(packageAt(join(PROJECT, 'src/client/DraftEditor.tsx')), manifest.name)
  assert.deepEqual(installedAt(manifest.name), [''])
  assert.ok(visibleFrom('', 'typescript'))
  assert.ok(visibleFrom('node_modules/@types/react', 'csstype'), 'a package finds what is installed at the top level')
  assert.ok(!visibleFrom('', 'no-such-package'))
})

test('every package the typecheck reads declarations from is one npm ci installs where the importing package finds it', () => {
  const missing = new Map(), reached = new Set()
  for (const { file, specifier } of typecheckImports()) {
    const name = packageOf(specifier)
    if (name === undefined || isAsset(specifier, name)) continue
    reached.add(name)
    const importer = packageAt(file)
    if (importer === undefined) continue
    // A package npm ci does not install is read only where something else supplies it (a link farm). Its own
    // imports are checked as if it were installed where declaring it puts it, so one run reports every layer.
    const bases = installedAt(importer)
    if (bases.length === 0) bases.push(`node_modules/${importer}`)
    if (bases.some(base => visibleFrom(base, name) || visibleFrom(base, typesPackage(name)))) continue
    if (!missing.has(name)) missing.set(name, `${name} (imported by ${relative(PROJECT, file)})`)
  }
  assert.deepEqual([...missing.values()].sort(), [], 'npm installs no package\'s devDependencies: declare each in devDependencies at the version the host has (its @types package for a types-only name such as mdast)')
  for (const name of ['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-api-remote-access']) {
    assert.ok(reached.has(name), `the census reads the Harness packages' declarations, which import ${name}, not only the plugin's own imports`)
  }
})

/**
 * The files of the installed package at `directory` that Node can load: the
 * JavaScript its exports and main name, and every file those import by a
 * relative path. A built checkout's lib/ holds more (tsc's intermediate output
 * beside the declarations), which nothing loads and npm does not publish.
 */
function runtimeFiles(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const queue = []
  const collect = (value, condition) => {
    if (typeof value === 'string') { if (condition !== 'types' && /\.[cm]?js$/.test(value) && !value.includes('*')) queue.push(join(directory, value)) }
    else if (value !== null && typeof value === 'object') for (const [key, target] of Object.entries(value)) collect(target, key)
  }
  collect(manifest.exports)
  collect(manifest.main)
  const files = new Set()
  while (queue.length) {
    const file = queue.pop()
    if (files.has(file) || !existsSync(file)) continue
    files.add(file)
    for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
      if (/^\.\.?\//.test(fileName) && /\.[cm]?js$/.test(fileName)) queue.push(join(dirname(file), fileName))
    }
  }
  return [...files]
}

test('every package the code of an installed Harness package imports is one npm ci installs where that package finds it', () => {
  const missing = new Map(), loaded = new Set()
  for (const path of Object.keys(lock.packages).filter(path => /(?:^|\/)node_modules\/@deepseek-ai\/[^/]+$/.test(path))) {
    const directory = join(PROJECT, path)
    // A link farm holds only the checkout's packages, and only at the top level; npm ci installs every entry.
    if (!existsSync(join(directory, 'package.json'))) continue
    const { name } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    for (const file of runtimeFiles(directory)) {
      loaded.add(relative(PROJECT, file))
      for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
        const imported = packageOf(fileName)
        if (imported === undefined || imported === name || visibleFrom(path, imported)) continue
        if (!missing.has(imported)) missing.set(imported, `${imported} (imported by ${relative(PROJECT, file)})`)
      }
    }
  }
  assert.deepEqual([...missing.values()].sort(), [], 'a client package\'s run-time imports are its devDependencies, which npm does not install: declare each in devDependencies at the version the checkout\'s copy of the importing package resolves')
  for (const file of ['node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js', 'node_modules/@deepseek-ai/dsh-client-ui-commands/lib/client.js']) {
    assert.ok(loaded.has(file), `the census reads ${file}, which the UI tests load`)
  }
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
