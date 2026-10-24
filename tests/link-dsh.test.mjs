/**
 * scripts/link-dsh.mjs overlays a built Harness checkout on whatever base
 * node_modules has: the packages `npm ci` installed from package-lock.json, or
 * nothing (a link farm made by link-dsh alone). The checkout and the repository
 * here are scratch directories with package manifests only; no Harness, npm
 * registry or real node_modules is used.
 *
 * Before T2 it refused any @deepseek-ai package npm had installed, so `npm ci`
 * and `npm run link:dsh` could not be combined, and it linked a hand-kept tool
 * list without jsdom, so a link farm could not run the UI tests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { linkHarness } from '../scripts/link-dsh.mjs'

const RELEASE = '0.2.1-rc.2'

function writePackage(directory, manifest, files = {}) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), text)
  }
}

/** A built-checkout stand-in and a repository whose devDependencies name its packages and three tools. */
function scene(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'link-dsh-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const harness = join(root, 'harness')
  writePackage(harness, { name: '@deepseek-ai/dsh-root', version: RELEASE })
  writePackage(join(harness, 'vendor/cordis'), { name: '@deepseek-ai/cordis', version: '4.0.5' })
  writePackage(join(harness, 'packages/core/agent'), { name: '@deepseek-ai/dsh-agent', version: RELEASE })
  writePackage(join(harness, 'packages/core/agent-loop'), { name: '@deepseek-ai/dsh-agent-loop', version: RELEASE })
  writePackage(join(harness, 'apps/cli'), { name: '@deepseek-ai/dsh', version: RELEASE })
  writePackage(join(harness, 'node_modules/typescript'), { name: 'typescript', version: '6.0.3', bin: { tsc: './bin/tsc' } }, { 'bin/tsc': '#!/usr/bin/env node\n' })
  writePackage(join(harness, 'node_modules/jsdom'), { name: 'jsdom', version: '29.1.1' })
  writePackage(join(harness, 'packages/client/web/node_modules/react'), { name: 'react', version: '18.3.1' })
  const repo = join(root, 'repo')
  writePackage(repo, { name: 'plugin', devDependencies: {
    '@deepseek-ai/cordis': '4.0.5', '@deepseek-ai/dsh-agent': RELEASE, '@deepseek-ai/dsh-agent-loop': RELEASE,
    typescript: '6.0.3', jsdom: '29.1.1', react: '18.3.1',
  } })
  const modules = join(repo, 'node_modules')
  return {
    harness, repo, modules,
    /** What `npm ci` leaves: a copy of each declared package, with the bins npm links. */
    npmCi(versions = {}) {
      for (const [name, version] of Object.entries(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).devDependencies)) {
        writePackage(join(modules, name), { name, version: versions[name] ?? version, ...(name === 'typescript' ? { bin: { tsc: './bin/tsc' } } : {}) }, name === 'typescript' ? { 'bin/tsc': '#!/usr/bin/env node\n' } : {})
      }
      writePackage(join(modules, '@deepseek-ai/node-addon-system'), { name: '@deepseek-ai/node-addon-system', version: '0.1.2' })
    },
    target: name => realpathSync(join(modules, name)),
    isLink: name => lstatSync(join(modules, name)).isSymbolicLink(),
  }
}

test('after npm ci, link-dsh replaces the Harness packages npm installed with the checkout\'s and keeps the tools the lockfile owns', t => {
  const s = scene(t)
  s.npmCi()
  const result = linkHarness(s.repo, s.harness)
  for (const [name, path] of [['@deepseek-ai/cordis', 'vendor/cordis'], ['@deepseek-ai/dsh-agent', 'packages/core/agent'], ['@deepseek-ai/dsh-agent-loop', 'packages/core/agent-loop'], ['@deepseek-ai/dsh', 'apps/cli']]) {
    assert.ok(s.isLink(name), `${name} is a link`)
    assert.equal(s.target(name), join(s.harness, path), `${name} is the checkout's own module`)
  }
  assert.deepEqual([...result.replaced].sort(), ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop'])
  assert.deepEqual([...result.kept].sort(), ['jsdom', 'react', 'typescript'], 'compilers, React and jsdom stay as the lockfile installed them')
  assert.deepEqual(result.tools, [])
  for (const name of ['jsdom', 'react', 'typescript']) assert.ok(!s.isLink(name), `${name} is npm's copy`)
  assert.ok(!s.isLink('@deepseek-ai/node-addon-system'), 'a package the checkout does not provide is left as npm installed it')
})

test('on an empty node_modules, link-dsh builds the whole link farm, every declared tool with its bins included', t => {
  const s = scene(t)
  const result = linkHarness(s.repo, s.harness)
  assert.deepEqual([...result.tools].sort(), ['jsdom', 'react', 'typescript'])
  assert.equal(s.target('jsdom'), join(s.harness, 'node_modules/jsdom'), 'the UI tests\' DOM comes from the farm too')
  assert.equal(s.target('react'), join(s.harness, 'packages/client/web/node_modules/react'))
  assert.equal(readlinkSync(join(s.modules, '.bin/tsc')), '../typescript/bin/tsc')
  assert.equal(realpathSync(join(s.modules, '.bin/tsc')), join(s.harness, 'node_modules/typescript/bin/tsc'))
  // Linking again over its own farm is the same farm.
  assert.deepEqual(linkHarness(s.repo, s.harness), { ...result, kept: [], replaced: [] })
})

test('a devDependency the checkout installed only in its pnpm store is linked from there, at the version package.json pins', t => {
  const s = scene(t)
  const store = join(s.harness, 'node_modules/.pnpm')
  // The packages the client packages bundle: the checkout's pnpm store has them, under their peers' suffix.
  writePackage(join(store, 'zustand@4.4.0/node_modules/zustand'), { name: 'zustand', version: '4.4.0' })
  writePackage(join(store, 'zustand@4.5.7_immer@10.2.0_react@18.3.1/node_modules/zustand'), { name: 'zustand', version: '4.5.7' })
  writePackage(join(store, '@shikijs+langs@4.4.3/node_modules/@shikijs/langs'), { name: '@shikijs/langs', version: '4.4.3' })
  // A copy installed at another version does not hide the store's copy at the pinned one.
  writePackage(join(s.harness, 'node_modules/diff'), { name: 'diff', version: '8.0.0' })
  writePackage(join(store, 'diff@9.0.0/node_modules/diff'), { name: 'diff', version: '9.0.0' })
  writePackage(join(store, 'diff-sequences@9.0.0/node_modules/diff-sequences'), { name: 'diff-sequences', version: '9.0.0' })
  const manifest = JSON.parse(readFileSync(join(s.repo, 'package.json'), 'utf8'))
  const declare = extra => writePackage(s.repo, { ...manifest, devDependencies: { ...manifest.devDependencies, ...extra } })
  declare({ zustand: '4.5.7', '@shikijs/langs': '4.4.3', diff: '9.0.0' })
  const result = linkHarness(s.repo, s.harness)
  assert.deepEqual([...result.tools].sort(), ['@shikijs/langs', 'diff', 'jsdom', 'react', 'typescript', 'zustand'])
  assert.equal(s.target('zustand'), join(store, 'zustand@4.5.7_immer@10.2.0_react@18.3.1/node_modules/zustand'))
  assert.equal(s.target('@shikijs/langs'), join(store, '@shikijs+langs@4.4.3/node_modules/@shikijs/langs'))
  assert.equal(s.target('diff'), join(store, 'diff@9.0.0/node_modules/diff'))
  // A pinned version the checkout has nowhere is a conflict that names a version it has; none at all is the other conflict.
  rmSync(s.modules, { recursive: true })
  declare({ zustand: '5.0.0', anser: '2.3.5' })
  assert.throws(() => linkHarness(s.repo, s.harness), error => {
    assert.match(error.message, /zustand: package\.json pins 5\.0\.0, the checkout has 4\.4\.0/)
    assert.match(error.message, /anser: declared in devDependencies, but npm installed none and the checkout has none/)
    return true
  })
  assert.ok(!existsSync(s.modules), 'nothing was linked')
})

test('link-dsh refuses, changing nothing, when the lockfile and the checkout name different versions or a declared package is nowhere', t => {
  const s = scene(t)
  s.npmCi({ '@deepseek-ai/dsh-agent': '0.2.1-rc.1' })
  rmSync(join(s.modules, 'jsdom'), { recursive: true })
  rmSync(join(s.harness, 'node_modules/jsdom'), { recursive: true })
  writePackage(join(s.harness, 'node_modules/typescript'), { name: 'typescript', version: '6.0.4' })
  rmSync(join(s.modules, 'typescript'), { recursive: true })
  assert.throws(() => linkHarness(s.repo, s.harness), error => {
    assert.match(error.message, /nothing was changed/)
    assert.match(error.message, /@deepseek-ai\/dsh-agent: npm installed 0\.2\.1-rc\.1, the checkout has 0\.2\.1-rc\.2/)
    assert.match(error.message, /jsdom: declared in devDependencies, but npm installed none and the checkout has none/)
    assert.match(error.message, /typescript: package\.json pins 6\.0\.3, the checkout has 6\.0\.4/)
    return true
  })
  assert.ok(!s.isLink('@deepseek-ai/cordis'), 'no package was replaced before the refusal')
  assert.equal(JSON.parse(readFileSync(join(s.modules, '@deepseek-ai/dsh-agent/package.json'), 'utf8')).version, '0.2.1-rc.1')
  assert.ok(!existsSync(join(s.modules, 'typescript')))
})

test('link-dsh still removes a link into the checkout that names no package any more, and keeps an unrelated manual link', t => {
  const s = scene(t)
  writePackage(join(s.harness, 'packages/core/retired'), { name: '@deepseek-ai/dsh-retired', version: RELEASE })
  linkHarness(s.repo, s.harness)
  assert.ok(s.isLink('@deepseek-ai/dsh-retired'))
  // The checkout renames the package: the old name's link still resolves into the checkout.
  writePackage(join(s.harness, 'packages/core/retired'), { name: '@deepseek-ai/dsh-renamed', version: RELEASE })
  const manual = join(resolve(s.repo, '..'), 'manual')
  writePackage(manual, { name: '@deepseek-ai/dsh-manual', version: '1.0.0' })
  symlinkSync(manual, join(s.modules, '@deepseek-ai/dsh-manual'), 'dir')
  linkHarness(s.repo, s.harness)
  assert.throws(() => lstatSync(join(s.modules, '@deepseek-ai/dsh-retired')), { code: 'ENOENT' }, 'a retired name must not mask its removal')
  assert.equal(s.target('@deepseek-ai/dsh-renamed'), join(s.harness, 'packages/core/retired'))
  assert.equal(s.target('@deepseek-ai/dsh-manual'), manual)
})
