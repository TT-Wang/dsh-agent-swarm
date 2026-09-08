/** Generate static, synthetic-data visual QA artifacts. This never opens a Harness profile. */
import { mkdir, writeFile } from 'node:fs/promises'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { uiSnapshot } from '../tests/fixtures/ui-snapshot.mjs'
import { SwarmBoard } from '../lib/types/client/SwarmBoard.js'
import { SWARM_CSS } from '../lib/types/client/styles.js'

await mkdir('artifacts/ui', { recursive: true })
for (const view of ['board', 'evidence', 'activity']) {
  const board = renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot: uiSnapshot(), initialView: view }))
  await writeFile(`artifacts/ui/${view}.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Swarm — synthetic UI preview</title><style>body{margin:0;padding:24px;background:#0b1116}main{max-width:1180px;margin:auto}${SWARM_CSS}</style><main>${board}</main></html>`)
}
