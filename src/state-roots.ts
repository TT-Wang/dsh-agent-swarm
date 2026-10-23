/**
 * F3: the one rule for where the plugin keeps its store and its workspaces.
 *
 * Both mounts, the plugin package's own bundle layer and the declarative bundle
 * in `profile/`, insert the plugin row with an empty config, so this module is
 * the only place a root is chosen. Each of `statePath` and `workspacesRoot`
 * comes from the first step that names it:
 *
 *   1. the row's config, which must be absolute;
 *   2. `$DSH_AGENT_SWARM_ROOT`, the plugin's own root;
 *   3. the Harness home + `/agent-swarm`: `$DSH_HOME`, else `~/.dsh`.
 *
 * The home is the host's own `resolveDshHome`, read at apply() from the
 * environment the host resolves its home from: a blank `$DSH_HOME` is unset, a
 * leading `~` is expanded and a relative value is resolved. The plugin's own
 * variable is read by the same rule. A configured root is the caller's
 * statement and cannot move; a derived one moves when the environment does, so
 * the start report checks the stores the lower steps would open.
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DSH_HOME_ENV, defaultDshHome, expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** The plugin's own root variable, above the Harness home. */
export const SWARM_ROOT_ENV = 'DSH_AGENT_SWARM_ROOT'

/** The rule step that chose a root. */
export type SwarmRootSource = 'config' | typeof SWARM_ROOT_ENV | typeof DSH_HOME_ENV | 'default'

/** The two roots one start uses, the step that chose each, and the stores a moved environment would leave behind. */
export interface SwarmRoots {
  readonly statePath: string
  readonly workspacesRoot: string
  readonly sources: { readonly statePath: SwarmRootSource, readonly workspacesRoot: SwarmRootSource }
  /**
   * The store files the lower steps of the rule name under this environment,
   * each other than `statePath`, highest first. Empty when `statePath` is
   * configured.
   */
  readonly otherStores: readonly string[]
}

/** The roots a start may configure; anything else in the config is ignored here. */
export interface SwarmRootsConfig {
  readonly statePath?: string | undefined
  readonly workspacesRoot?: string | undefined
}

const ROOT_DIR = 'agent-swarm'
const STORE_FILE = 'swarm.sqlite'
const WORKSPACES_DIR = 'workspaces'

/** A root variable's value, or undefined when it is unset or blank, as the host reads `$DSH_HOME`. */
function rootSetting(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

interface DerivedRoot { readonly source: SwarmRootSource, readonly root: string }

/** The derived roots under one environment, highest first, each path once; the first is the one chosen. */
function derivedRoots(env: Record<string, string | undefined>): [DerivedRoot, ...DerivedRoot[]] {
  const own = rootSetting(env, SWARM_ROOT_ENV)
  const home: DerivedRoot = { source: rootSetting(env, DSH_HOME_ENV) === undefined ? 'default' : DSH_HOME_ENV, root: join(resolveDshHome(undefined, env), ROOT_DIR) }
  const fallback: DerivedRoot = { source: 'default', root: join(defaultDshHome(), ROOT_DIR) }
  const [chosen, ...lower]: [DerivedRoot, ...DerivedRoot[]] = own === undefined ? [home, fallback] : [{ source: SWARM_ROOT_ENV, root: resolve(expandHomePath(own)) }, home, fallback]
  const distinct: [DerivedRoot, ...DerivedRoot[]] = [chosen]
  for (const candidate of lower) if (!distinct.some(seen => seen.root === candidate.root)) distinct.push(candidate)
  return distinct
}

/**
 * Resolve the store and workspaces roots by the one rule above.
 * @param config - the row's config; only `statePath` and `workspacesRoot` are read.
 * @param env - the environment the host resolved its home from.
 * @throws when a configured root is not absolute.
 */
export function swarmRoots(config: SwarmRootsConfig, env: Record<string, string | undefined> = process.env): SwarmRoots {
  for (const configured of [config.statePath, config.workspacesRoot]) {
    if (configured !== undefined && !isAbsolute(configured)) throw new Error('Swarm statePath and workspacesRoot must be absolute')
  }
  const [derived, ...lower] = derivedRoots(env)
  return {
    statePath: config.statePath ?? join(derived.root, STORE_FILE),
    workspacesRoot: config.workspacesRoot ?? join(derived.root, WORKSPACES_DIR),
    sources: {
      statePath: config.statePath === undefined ? derived.source : 'config',
      workspacesRoot: config.workspacesRoot === undefined ? derived.source : 'config',
    },
    otherStores: config.statePath === undefined ? lower.map(candidate => join(candidate.root, STORE_FILE)) : [],
  }
}

/** How the start report names each step. */
const SOURCE_LABEL: Record<SwarmRootSource, string> = {
  config: 'configured',
  [SWARM_ROOT_ENV]: `$${SWARM_ROOT_ENV}`,
  [DSH_HOME_ENV]: `$${DSH_HOME_ENV}`,
  default: 'default home',
}

interface RootsLogger { info(message: string): void, warn(message: string): void }

/**
 * Log the resolved roots once at start, and warn once, naming both paths, when
 * this start opens a new store while a lower step of the rule already holds
 * one. A changed `$DSH_HOME`, a dropped `$DSH_AGENT_SWARM_ROOT` or an upgrade
 * from a build that ignored them then never opens an empty store silently.
 * Nothing is adopted: under another home that store belongs to another host.
 * Call it after a pending restore is applied, so a restored store counts as
 * present.
 * @returns the other stores the warning named.
 */
export function reportSwarmRoots(logger: RootsLogger | undefined, roots: SwarmRoots): string[] {
  const found = existsSync(roots.statePath) ? [] : roots.otherStores.filter(path => existsSync(path))
  try {
    logger?.info(`agent-swarm: store ${roots.statePath} (${SOURCE_LABEL[roots.sources.statePath]}), workspaces ${roots.workspacesRoot} (${SOURCE_LABEL[roots.sources.workspacesRoot]})`)
    const [nearest] = found
    if (nearest !== undefined) {
      logger?.warn(`agent-swarm: opening a new store at ${roots.statePath}, but a store already exists at ${found.join(' and at ')}; its missions are not moved. `
        + `To keep using it, stop this host and set ${SWARM_ROOT_ENV}=${dirname(nearest)} (or configure statePath and workspacesRoot).`)
    }
  } catch { /* Logging must never veto the plugin. */ }
  return found
}
