/** Copy sets for running a repository script from a scratch checkout. */
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

/**
 * `entry` (a path relative to `root`) and every local module it imports with a
 * static `import ... from './x.mjs'` or `import '../y.mjs'`, transitively, as
 * { relative path: source }. A new local import in the script is then copied
 * with it, instead of breaking the copy.
 */
export async function withLocalImports(root, entry, files = {}) {
  if (entry in files) return files
  files[entry] = await readFile(join(root, entry), 'utf8')
  for (const [, specifier] of files[entry].matchAll(/^import\s+(?:[^'"`;]*?\bfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    await withLocalImports(root, posix.join(posix.dirname(entry), specifier), files)
  }
  return files
}
