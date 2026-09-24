/**
 * tests/fixtures/local-imports.mjs: the copy set of a script is the script and
 * its static local imports, transitively. Fault F4 copies scripts/round.mjs this
 * way; a hard-coded list broke it when round.mjs gained an import.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withLocalImports } from './fixtures/local-imports.mjs'

test('withLocalImports follows static local imports transitively, through cycles and parent directories, and nothing else', async t => {
  const root = mkdtempSync(join(tmpdir(), 'local-imports-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    'scripts/a.mjs': "import assert from 'node:assert/strict'\nimport {\n  b,\n} from './b.mjs'\nconst path = './not-an-import.mjs'\nawait import('./dynamic.mjs')\n",
    'scripts/b.mjs': "import { c } from '../lib/c.mjs'\nexport const b = c\n",
    'lib/c.mjs': "import './side-effect.mjs'\nimport { b } from '../scripts/b.mjs'\nexport const c = 1\n",
    'lib/side-effect.mjs': '',
  }
  for (const [path, source] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source) }
  assert.deepEqual(await withLocalImports(root, 'scripts/a.mjs'), files)
})

test('scripts/round.mjs is copied with every local module it imports', async () => {
  const project = fileURLToPath(new URL('../', import.meta.url))
  const copied = Object.keys(await withLocalImports(project, 'scripts/round.mjs'))
  assert.equal(copied[0], 'scripts/round.mjs')
  assert.ok(copied.includes('scripts/host.mjs'), copied.join(', '))
})
