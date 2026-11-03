// Keyless shipped-Web acceptance for the Workflows overlay (OP-240). The two
// shipped example workflows are copied into the connected workspace's
// `.workflows` directory; the real Host Remote namespace, run store and
// browser plugin serve the overlay over real HTTP. No model call is issued,
// and the dry-run opened here starts nothing (no run record, no shell call).
// The golden pins the workflow list; the dry-run assertions pin the trust
// gate: the Host's exact confirm text is shown and the acknowledgement box
// guards the run button.
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/workflows', import.meta.url))
const LIST_EXPECTED = join(SNAPSHOT_DIR, 'list.expected.md')
const EXAMPLES_DIR = join(REPO_ROOT, 'examples/workflows')
const SEED_ID = 'workflows-web-e2e'
const DONE = 'WORKFLOWS_SEED_DONE'

/** One settled turn so the session has a conversation header (the Workflows button lives there). */
function seedFixture(): string {
  const session = Session.create(SessionId('workflows-source'))
  const origin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Open the workflows panel.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: 'Workflows overlay', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: DONE }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}' }),
    ...session.events.map(event => JSON.stringify({ ...event, time: origin + event.seq * 1_000 })),
    '',
  ].join('\n')
}

describe.skipIf(MODE === 'record')('web e2e: Workflows overlay lists the examples and opens a dry-run', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    // The seeded session runs in the scaffold's workspace; plant the examples in its `.workflows`.
    const dir = join(scaffold.workspaceCwd, '.workflows')
    await mkdir(dir, { recursive: true })
    for (const file of (await readdir(EXAMPLES_DIR)).filter(name => name.endsWith('.yaml'))) {
      await copyFile(join(EXAMPLES_DIR, file), join(dir, file))
    }
    await seedSession(scaffold, seedFixture(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.getByText(DONE, { exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens from the header button and lists feature-loop and mail-triage', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workflows-list'))
    await page.locator('[data-workflows-button]').first().click()
    const overlay = page.locator('[data-workflows-overlay]')
    await overlay.waitFor({ timeout: 15_000 })
    expect(await overlay.getAttribute('data-workflows-tab')).toBe('workflows')
    const rows = overlay.locator('[data-workflow-row]')
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(2)
    const names = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-workflow-name')))
    expect(names.sort()).toEqual(['feature-loop', 'mail-triage'])
    for (const row of await rows.all()) expect(await row.getAttribute('data-workflow-valid')).toBe('true')

    const snapshot = await captureStableAria(page, '[data-workflow-list]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(LIST_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('dry-run shows the plan, the Host confirm text and a guarded acknowledgement box', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-workflows-dryrun'))
    const overlay = page.locator('[data-workflows-overlay]')
    await overlay.locator('[data-workflow-row][data-workflow-name="mail-triage"]').click()
    await overlay.locator('[data-workflow-editor]').waitFor({ timeout: 15_000 })
    await overlay.locator('[data-dryrun]').click()

    const view = overlay.locator('[data-dryrun-view]')
    await view.waitFor({ timeout: 15_000 })
    await expect.poll(() => view.getAttribute('data-dryrun-status'), { timeout: 15_000 }).not.toBe('loading')
    // Declared nodes and gates come from the Host plan: five nodes, four gates.
    await expect.poll(() => view.locator('[data-plan-node]').count(), { timeout: 15_000 }).toBe(5)
    expect(await view.locator('[data-gate-entry]').count()).toBe(4)
    expect(await view.locator('[data-trust-command]').count()).toBeGreaterThanOrEqual(2)
    expect(await view.locator('[data-trust-state="untrusted"]').count()).toBe(1)

    const confirm = view.locator('[data-confirm-text]')
    await confirm.waitFor({ timeout: 10_000 })
    expect(await confirm.innerText()).toContain('mail-cli send')
    const ack = view.locator('[data-trust-ack]')
    await ack.waitFor({ timeout: 10_000 })
    const run = view.locator('[data-run-start]')
    expect(await run.getAttribute('data-trust-run')).toBe('true')
    expect(await run.isDisabled()).toBe(true)
    await ack.check()
    await expect.poll(() => run.isDisabled(), { timeout: 5_000 }).toBe(false)
    await ack.uncheck()
    await expect.poll(() => run.isDisabled(), { timeout: 5_000 }).toBe(true)
    // A dry-run starts nothing: the Runs tab has no run.
    await overlay.locator('[data-workflows-tab-button="runs"]').click()
    await overlay.locator('[data-run-list]').waitFor({ state: 'attached', timeout: 10_000 })
    expect(await overlay.locator('[data-run-row]').count()).toBe(0)
  }, 60_000)

  it('stays clean and owns only its one golden', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['list.expected.md'])
  })
})
