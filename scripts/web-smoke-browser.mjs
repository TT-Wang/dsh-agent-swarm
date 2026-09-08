import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Keep the native launch credential only in memory, never in saved evidence. */
export function redactWebSecrets(value) {
  return String(value).replace(/([?&]token=)[^\s)"'<>]+/g, '$1[REDACTED]')
}
export function authenticatedLaunchUrl(output) {
  return output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+/)?.[0]
}
export function publicBaseUrl(launchUrl) { return new URL(launchUrl).origin }
export function publicFailure(error) { return new Error(redactWebSecrets(error instanceof Error ? error.stack ?? error.message : error)) }

/** Exchange the product's native launch token for its HttpOnly browser cookie. */
export async function openAuthenticatedWeb(page, launchUrl, checks) {
  const baseUrl = publicBaseUrl(launchUrl)
  assert.equal((await fetch(baseUrl)).status, 401, 'unauthenticated index stays protected')
  await page.goto(launchUrl, { waitUntil: 'load' })
  assert.equal(new URL(page.url()).searchParams.has('token'), false, 'native token exchange redirects to a clean URL')
  assert((await page.context().cookies(baseUrl)).some(cookie => cookie.httpOnly), 'native login issues an HttpOnly cookie')
  assert.equal((await page.request.get(baseUrl)).status(), 200, 'authenticated browser can fetch the native web app')
  checks.push('native launch authentication remains enabled: unauthenticated index401, token exchange, HttpOnly cookie, authenticated index200')
}

/** Current Harness has a resident Lexical contenteditable composer. */
export function composerFor(page) { return page.locator('[data-composer-input][contenteditable="true"]').first() }

export async function selectWebWorkspace(page, workspace) {
  const trigger = page.getByRole('textbox', { name: 'Choose workspace', exact: true })
  const welcome = page.getByRole('button', { name: 'Continue', exact: true })
  await Promise.race([trigger.waitFor(), welcome.waitFor()])
  if (await welcome.isVisible()) await welcome.click()
  await trigger.click()
  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await picker.getByRole('button', { name: 'Edit path' }).click()
  const path = picker.getByRole('textbox', { name: 'Edit path' })
  await path.fill(workspace)
  await path.press('Enter')
  await picker.getByRole('button', { name: 'Open', exact: true }).click()
  await composerFor(page).waitFor()
}

/** Isolate the scripted Host adapter from the real browser plugin's package identity. */
export async function isolateWebModelFixture(root, project, filename) {
  const directory = join(root, 'scripted-model-fixture')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-swarm-web-test-model', version: '0.0.0', type: 'module' }))
  const helper = pathToFileURL(join(project, 'tests/fixtures/built-harness.mjs')).href
  const source = (await readFile(join(project, 'tests/fixtures', filename), 'utf8')).replace("from './built-harness.mjs'", `from ${JSON.stringify(helper)}`)
  const entry = join(directory, 'index.mjs')
  await writeFile(entry, source)
  return pathToFileURL(entry).href
}

/** Mirror Harness's public browser-test gesture: Lexical must absorb selection between keys. */
export async function writeComposerDraft(page, input, text) {
  await input.and(page.locator('[contenteditable="true"]')).waitFor({ timeout: 15_000 })
  await input.click()
  await page.keyboard.press('ControlOrMeta+A')
  if (text === '') await page.keyboard.press('Backspace')
  else await page.keyboard.type(text)
}
