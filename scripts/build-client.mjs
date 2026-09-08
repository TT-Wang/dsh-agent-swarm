/** Browser bundle contract: Harness packages/client/tsdown.client.ts (MIT).
 * One closure factory, shared React identities, no host imports or extra routes.
 */
import { readFile } from 'node:fs/promises'
import { build } from 'tsdown'

const { name } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const platform = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives']
await build({
  config: false, entry: { client: 'src/client/index.tsx' }, outDir: 'lib',
  format: 'cjs', platform: 'browser', target: 'es2022', dts: false, clean: false, sourcemap: true,
  deps: { neverBundle: platform, alwaysBundle: id => !platform.includes(id) },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'swarm-client-purity', resolveId(source) {
    if (source.startsWith('@deepseek-ai/') && !platform.includes(source)) {
      throw new Error(`Unexpected host or cross-plugin runtime import in browser: ${source}`)
    }
    return null
  } }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
