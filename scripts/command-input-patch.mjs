/**
 * patches/harness-command-input.patch as it declares itself: the Harness
 * releases on the `Targets:` line of its preamble, which `git apply` ignores,
 * and the files its diff corrects. scripts/check-harness-command-input.mjs and
 * the tests read the declaration here, so the patch file is its one source.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const COMMAND_INPUT_PATCH = fileURLToPath(new URL('../patches/harness-command-input.patch', import.meta.url))

/** @returns {{ path: string, targets: string[], files: string[] }} the patch's declared releases and corrected files. */
export async function commandInputPatch(path = COMMAND_INPUT_PATCH) {
  const text = await readFile(path, 'utf8')
  const preamble = text.slice(0, text.indexOf('\ndiff --git ') + 1)
  const targets = preamble.match(/^Targets:(.*)$/m)?.[1].trim().split(/\s+/).filter(Boolean) ?? []
  assert(targets.length > 0, `${path} declares no Targets line before its diff`)
  const files = [...text.matchAll(/^diff --git a\/(\S+) b\//gm)].map(match => match[1])
  assert(files.length > 0, `${path} corrects no file`)
  return { path, targets, files }
}
