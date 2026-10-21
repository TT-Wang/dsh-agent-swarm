/**
 * patches/harness-command-input.patch declares the releases it targets, and
 * scripts/check-harness-command-input.mjs judges a checkout by that
 * declaration and by the file the patch corrects. The fake checkouts here hold
 * only a release manifest and, where a case needs it, the corrected file's
 * path, so no Harness is needed (the regression itself runs against
 * a built checkout: patches/README.md).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMAND_INPUT_PATCH, commandInputPatch } from '../scripts/command-input-patch.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))

/** A checkout of `version` that ships `files`; the check script's exit code and output on it. */
function check(t, version, files = []) {
  const root = mkdtempSync(join(tmpdir(), 'command-input-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
  for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), '') }
  return new Promise(resolve => execFile(process.execPath, [join(project, 'scripts/check-harness-command-input.mjs'), root], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })))
}

test('the patch targets only supported releases and corrects one ui-conversation file', async () => {
  const patch = await commandInputPatch()
  const supported = JSON.parse(readFileSync(join(project, 'compatibility.json'), 'utf8')).supportedHosts.map(host => host.version)
  assert.deepEqual(patch.targets, ['0.1.5-rc.3', '0.1.7-rc.1'])
  for (const target of patch.targets) assert.ok(supported.includes(target), `${target} is a supported release; drop it from the patch with its support`)
  assert.deepEqual(patch.files, ['packages/client/ui-conversation/src/client/input/editor/claim-decor.ts'])
})

test('a release without the corrected file is reported not affected, and one that still ships it untargeted is refused', async t => {
  const { files } = await commandInputPatch()
  const absent = await check(t, '0.2.1-rc.2')
  assert.equal(absent.code, 0, absent.stderr)
  assert.match(absent.stdout, /^NOT AFFECTED: Harness 0\.2\.1-rc\.2 ships no packages\/client\/ui-conversation\/src\/client\/input\/editor\/claim-decor\.ts/)
  const untargeted = await check(t, '0.1.6-alpha.2', files)
  assert.equal(untargeted.code, 1)
  assert.match(untargeted.stderr, /Harness 0\.1\.6-alpha\.2 still ships .*claim-decor\.ts, but the patch targets only 0\.1\.5-rc\.3, 0\.1\.7-rc\.1/)
})

test('a patch without a Targets line before its diff declares nothing', async t => {
  const root = mkdtempSync(join(tmpdir(), 'command-input-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const text = readFileSync(COMMAND_INPUT_PATCH, 'utf8')
  const bare = join(root, 'bare.patch')
  writeFileSync(bare, text.slice(text.indexOf('diff --git ')))
  await assert.rejects(commandInputPatch(bare), /declares no Targets line before its diff/)
})
