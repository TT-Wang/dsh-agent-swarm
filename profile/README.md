# @dsh-external/dsh-agent-swarm-profile

The declarative mount for the Agent Swarm platform. This package's runtime
content is its patch document ([`cordis.patch.yml`](cordis.patch.yml)) plus its
dependency on the platform it mounts; it exports no runtime API.

## What it composes

- The plugin row `dsh-external-agent-swarm` (`@dsh-external/dsh-agent-swarm`),
  inserted with an empty config, exactly as the plugin package's own layer
  inserts it, so the plugin chooses its two roots itself.
- The plugin's **Web client UI**, which mounts with that same row: the client
  module system scans mounted rows for a package declaring `dsh.client` for the
  web platform, and the inserted package declares exactly that (`./client` plus
  its inject list). No second row is needed.

## Prerequisites and conflicts (declared in `package.json`)

| declaration | value | meaning |
| --- | --- | --- |
| `dsh.bundle.patch` | `./cordis.patch.yml` | the package's runtime content |
| `dsh.bundle.requires.bundles` | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` | host layers that must precede this bundle in `dsh.profile.bundles` |
| `dsh.bundle.requires.harness` | the supported Harness release | mirrors [`../compatibility.json`](../compatibility.json) |
| `dsh.bundle.conflicts.bundles` | `@dsh-external/dsh-agent-swarm` | the plugin package's own bundle patch inserts the same row id, so mounting both layers duplicates it — mount either this bundle or the bare plugin, never both |
| `dependencies` | `@dsh-external/dsh-agent-swarm` (`file:..`) | the platform payload, resolved as the sibling package in this checkout |

## Mount

From the checkout root, after `npm run build`:

```sh
node "$DSH_HARNESS_ROOT/apps/cli/lib/bin.js" plugin --profile web add "file:$PWD/profile"
```

The CLI installs the bundle and its payload, and appends
`@dsh-external/dsh-agent-swarm-profile` to that profile's
`dsh.profile.bundles`. The platform is distributed as a source checkout and its
payload dependency is the sibling package, so a `file:` mount needs no registry
access; a registry publication of the same release would carry the version range
instead. Because a `file:` install packs the payload, re-run the command (or
`dsh plugin --profile web install`) after rebuilding the plugin.

## Roots

The composition states no root. Like the plugin package's own (direct mount)
layer, it inserts the row with an empty config, and the plugin resolves both
roots at start by one rule ([`src/state-roots.ts`](../src/state-roots.ts)):

```text
root           = $DSH_AGENT_SWARM_ROOT, else <Harness home>/agent-swarm
                 (the host's own home: $DSH_HOME, else ~/.dsh)
statePath      = root/swarm.sqlite
workspacesRoot = root/workspaces
```

The home is the host's own `resolveDshHome`, so a blank `DSH_HOME` is unset, a
leading `~` is expanded and a relative path is resolved, exactly as the host
reads it. Both mounts therefore open the same store under any environment, and
a mount switch cannot move it. A caller that needs another root — the attended
preview uses its own — sets `DSH_AGENT_SWARM_ROOT`, or overrides this row's
`config` in a later patch layer (a `--patch <file>` overlay or the profile's
own `cordis.patch.yml`), which is the layer order the launcher defines. Every
other plugin setting keeps its documented default; see
[storage roots](../docs/operations.md#storage-roots) and
[storage and configuration](../docs/operations.md#storage-and-configuration).

## Tests

`tests/r17-profile.test.mjs` proves the declared metadata, that both mounts
insert the row with no root of its own, the host profile loader composing the
bundle into exactly one row, the declared conflict being real, and real
`dsh --profile web` hosts opening the store under `$DSH_HOME/agent-swarm` (on
the bundle and on the direct mount, with the start log and the warning that
names the default home's store), under `DSH_AGENT_SWARM_ROOT` and under a caller
overlay, while serving the plugin's client bundle in the boot graph.
`tests/state-roots.test.mjs` covers each step of the rule and the warning.
