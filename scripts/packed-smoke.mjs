#!/usr/bin/env node
/**
 * F-21: packed-artifact smoke.
 *
 * Runs from an installed tarball (or from the repository after `npm run build`)
 * and proves that the shipped manifest's entry points and documents exist. It
 * imports only Node builtins on purpose: the published tarball has no
 * devDependencies, no `src/`, no `tests/` and no Harness checkout, so the full
 * verification suite requires the repository. See docs/known-limitations.md.
 */
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const shipped = ['README.md', 'LICENSE', 'NOTICE', 'compatibility.json', 'cordis.patch.yml', 'docs/design.md', 'docs/validation.md', 'docs/known-limitations.md']
for (const relative of shipped) await access(join(root, relative))
const targets = new Set()
for (const exported of Object.values(manifest.exports ?? {})) {
  if (typeof exported === 'string') targets.add(exported)
  else for (const target of Object.values(exported ?? {})) if (typeof target === 'string') targets.add(target)
}
for (const target of targets) await access(join(root, target))
assert.ok(targets.has('./lib/index.js'), 'the manifest must export the built main entry')
assert.ok(targets.has('./lib/client.js'), 'the manifest must export the built client entry')
process.stdout.write(`packed-smoke: ${targets.size} export target(s) and ${shipped.length} shipped file(s) present\n`)
