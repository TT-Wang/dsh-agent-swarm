# @dsh-external/dsh-agent-swarm-profile

The declarative mount for the Agent Swarm platform. This package's runtime
content is its patch document ([`cordis.patch.yml`](cordis.patch.yml)) plus its
dependency on the platform it mounts; it exports no runtime API.

## What it composes

- The plugin row `dsh-external-agent-swarm` (`@dsh-external/dsh-agent-swarm`),
  inserted with the two roots the platform owns stated explicitly.
- The plugin's **Web client UI**, which mounts with that same row: the client
  module system scans mounted rows for a package declaring `dsh.client` for the
  web platform, and the inserted package declares exactly that (`./client` plus
  its inject list). No second row is needed.

## Prerequisites and conflicts (declared in `package.json`)

| declaration | value | meaning |
| --- | --- | --- |
| `dsh.bundle.patch` | `./cordis.patch.yml` | the package's runtime content |
| `dsh.bundle.requires.bundles` | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` | host layers that must precede this bundle in `dsh.profile.bundles` |
| `dsh.bundle.requires.harness` | the exact supported Harness releases | mirrors [`../compatibility.json`](../compatibility.json) |
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

The composition states both roots as loader expressions instead of literal paths:

```text
root           = $DSH_AGENT_SWARM_ROOT ?? ($DSH_HOME ?? $HOME/.dsh) + '/agent-swarm'
statePath      = root + '/swarm.sqlite'
workspacesRoot = root + '/workspaces'
```

With no variable set this resolves to the plugin's own documented default
(`~/.dsh/agent-swarm/...`); with `DSH_HOME` set it follows the Harness home. A
caller that needs another root — the attended preview uses its own — sets
`DSH_AGENT_SWARM_ROOT`, or overrides this row's `config` in a later patch layer
(a `--patch <file>` overlay or the profile's own `cordis.patch.yml`), which is
the layer order the launcher defines. Every other plugin setting keeps its
documented default; see [storage and configuration](../README.md#storage-and-configuration).

## Tests

`tests/r17-profile.test.mjs` proves the declared metadata, the portable
composition (default, `DSH_HOME`, `DSH_AGENT_SWARM_ROOT` and caller-overlay
roots), the host profile loader composing the bundle into exactly one row, the
declared conflict being real, and a real `dsh --profile web` host serving the
plugin's client bundle in its boot graph.
