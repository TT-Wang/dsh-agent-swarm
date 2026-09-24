/** Unpaid regression for the native command-token patch, using the target's Lexical. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.argv.length !== 3 || process.argv[2].startsWith('-')) {
  console.error('Usage: node scripts/check-harness-command-input.mjs /path/to/deepseek-harness')
  process.exit(1)
}

const harness = resolve(process.argv[2])
const packageRoot = join(harness, 'packages/client/ui-conversation')
const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
const supported = JSON.parse(await readFile(new URL('../compatibility.json', import.meta.url), 'utf8')).supportedHosts.map(host => host.version)
assert(supported.includes(packageJson.version), `this patch targets the supported Harness releases (${supported.join(', ')}), not ${packageJson.version}`)
const require = createRequire(join(packageRoot, 'package.json'))
// Use the same ESM Lexical instance for the source module and test editor.
const lexicalUrl = pathToFileURL(require.resolve('lexical').replace(/\.js$/, '.mjs')).href
const headlessUrl = pathToFileURL(require.resolve('@lexical/headless').replace(/\.js$/, '.mjs')).href
const { $createParagraphNode, $createTextNode, $getRoot, $getSelection } = await import(lexicalUrl)
const { createHeadlessEditor } = await import(headlessUrl)
const sourcePath = 'src/client/input/editor/claim-decor.ts'
const original = await readFile(join(packageRoot, sourcePath), 'utf8')
const patch = fileURLToPath(new URL('../patches/harness-command-input.patch', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'dsh-command-input-regression-'))

try {
  const copiedSource = join(temporary, sourcePath)
  await mkdir(dirname(copiedSource), { recursive: true })
  await writeFile(copiedSource, original)
  // Apply the actual shipped patch to a disposable source copy. A missing or
  // mismatched patch fails here; the probe never edits the Harness checkout.
  execFileSync('git', ['apply', '--no-index', '-p4', patch], { cwd: temporary, stdio: 'pipe' })
  const patched = await readFile(copiedSource, 'utf8')
  assert.notEqual(patched, original, 'patch must change the copied source')
  const load = source => {
    const javascript = stripTypeScriptTypes(source, { mode: 'strip' })
      .replace(/from ['"]lexical['"]/g, `from ${JSON.stringify(lexicalUrl)}`)
    return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
  }
  const before = await load(original)
  const after = await load(patched)
  const TOKEN = '/agent-swarm '
  // 0.1.5 styles the token with the warn label, 0.1.7 with the business accent.
  const STYLE = original.match(/const TOKEN_STYLE = '([^']+)'/)[1]

  function bench(module, initial = TOKEN) {
    const editor = createHeadlessEditor({ namespace: 'claim-overflow-regression', onError(error) { throw error } })
    let claim = TOKEN
    const dispose = module.registerClaimDecoration(editor, () => claim)
    const update = body => editor.update(body, { discrete: true })
    update(() => { $getRoot().append($createParagraphNode().append($createTextNode(initial))) })
    const read = () => editor.getEditorState().read(() => $getRoot().getAllTextNodes()
      .map(node => ({ text: node.getTextContent(), style: node.getStyle() })))
    const append = text => update(() => {
      const node = $getRoot().getAllTextNodes().at(-1)
      // Mirrors Lexical's DOM-text reconciliation: update the existing
      // styled node's text, instead of rebuilding an unstyled draft.
      node.setTextContent(node.getTextContent() + text)
    })
    const pasteText = text => update(() => {
      $getRoot().getAllTextNodes().at(-1).selectEnd()
      $getSelection().insertText(text)
    })
    return {
      dispose, update, read, append, pasteText,
      release() { claim = null; update(() => { $getRoot().getAllTextNodes()[0]?.markDirty() }) },
    }
  }

  const broken = bench(before)
  assert.throws(() => broken.append('全'), /endlessly triggering additional transforms/)
  broken.dispose()
  console.log('PASS: original source reproduces endless split/merge when the styled token receives argument text')

  const typing = bench(after)
  for (const text of ['全', '面', 'r', 'e', 'v', 'i', 'e', 'w', ' ', '中文目标']) typing.append(text)
  assert.deepEqual(typing.read(), [{ text: TOKEN, style: STYLE }, { text: '全面review 中文目标', style: '' }])
  typing.dispose()
  console.log('PASS: mixed CJK/Latin text edits preserve content; only the command is styled')

  const paste = bench(after)
  paste.pasteText('全面 review 项目\n验证行为保持一致')
  assert.equal(paste.read().map(node => node.text).join(''), `${TOKEN}全面 review 项目\n验证行为保持一致`)
  assert.equal(paste.read().filter(node => node.style === STYLE).map(node => node.text).join(''), TOKEN)
  paste.dispose()
  console.log('PASS: paste preserves content and the command highlight boundary')

  const seeded = bench(after, `${TOKEN}一次性粘贴的完整命令`)
  assert.deepEqual(seeded.read(), [{ text: TOKEN, style: STYLE }, { text: '一次性粘贴的完整命令', style: '' }])
  seeded.dispose()
  console.log('PASS: full draft initialization leaves arguments unstyled')

  const deletion = bench(after)
  deletion.append('目标')
  deletion.update(() => { $getRoot().getAllTextNodes().at(-1).remove() })
  assert.deepEqual(deletion.read(), [{ text: TOKEN, style: STYLE }])
  deletion.append('重写')
  assert.deepEqual(deletion.read(), [{ text: TOKEN, style: STYLE }, { text: '重写', style: '' }])
  deletion.release()
  assert.deepEqual(deletion.read(), [{ text: `${TOKEN}重写`, style: '' }])
  deletion.dispose()
  console.log('PASS: deleting, retyping, and releasing the claim preserve text and remove stale styling')

  console.log('5 checks passed against the actual patch. Headless Lexical only; no OS IME/browser claim.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
