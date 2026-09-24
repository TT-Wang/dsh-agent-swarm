/** The Harness release this plugin runs on, read at apply() from the Harness package it loads. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The releases compatibility.json, the dsh-* peer ranges and the profile's requires.harness name (tests pin them together). */
export const SUPPORTED_HARNESS_RELEASES: readonly string[] = ['0.1.5-rc.3', '0.1.7-rc.1']

/** A Harness package every host provides and this plugin imports at runtime. */
const PROBE = '@deepseek-ai/dsh-session'

/**
 * The version in the manifest of the `@deepseek-ai/dsh-session` package this
 * module resolves: the host's own package, linked or behind the host's module
 * proxy (whose manifest carries the host package's version). Undefined when it
 * cannot be resolved or read.
 * @param resolve - specifier to module URL; the default resolves from this module.
 */
export function loadedHarnessVersion(resolve: (specifier: string) => string = specifier => import.meta.resolve(specifier)): string | undefined {
  try {
    for (let directory = dirname(fileURLToPath(resolve(PROBE))); ;) {
      let manifest: { name?: unknown, version?: unknown } | undefined
      try { manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (manifest?.name === PROBE) return typeof manifest.version === 'string' ? manifest.version : undefined
      const parent = dirname(directory)
      if (parent === directory) return undefined
      directory = parent
    }
  } catch { return undefined }
}

interface VersionLogger { error(message: string): void, warn(message: string): void }

/**
 * Log, never throw, when the host is not a supported release. 0.1.5-rc.3 has no
 * peer-version gate and neither host reads the profile's requires.harness, so
 * this is the one runtime notice an unsupported host gives.
 * @param read - the version source; undefined from it means unreadable.
 * @returns what was found, for the caller and the tests.
 */
export function reportHarnessSupport(logger: VersionLogger | undefined, read: () => string | undefined = loadedHarnessVersion): 'supported' | 'unsupported' | 'unknown' {
  const version = read()
  const supported = SUPPORTED_HARNESS_RELEASES.join(', ')
  const verdict = version === undefined ? 'unknown' : SUPPORTED_HARNESS_RELEASES.includes(version) ? 'supported' : 'unsupported'
  try {
    if (verdict === 'unsupported') logger?.error(`agent-swarm: Unsupported Harness ${version}; supported: ${supported}. The plugin still loads but is untested on this host; run it on a supported release.`)
    else if (verdict === 'unknown') logger?.warn(`agent-swarm: the Harness version could not be read from ${PROBE}; supported: ${supported}.`)
  } catch { /* Logging must never veto the plugin. */ }
  return verdict
}
