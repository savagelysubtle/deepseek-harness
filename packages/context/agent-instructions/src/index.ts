/**
 * Workspace instruction loader for AGENTS.md-compatible files.
 *
 * Baseline instructions enter durable context before the first request; successful fs
 * tool touches project nested, changed, and removed instructions into the inbox.
 * Plugin lifecycle reads use the optional `ctx.fs` provider, so providerless products
 * mount it as a no-op.
 *
 * @module @deepseek-ai/dsh-agent-instructions
 */

import type { Context } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { Config, resolveConfig, workspaceBaselineIdentity, type ResolvedConfig } from './config.ts'
import { findProjectRoot, loadBaselineInstructionSet } from './files.ts'
import {
  applyInstructionVersionUpdates,
  baselineInstructionState,
  name,
  reconcileInstructionContext,
  workspaceContextMessage,
  type InstructionVersionCache,
  type AgentInstructionSource,
} from './state.ts'
import type { AgentInstructionChange } from './render.ts'
import { describeBudgetOverflow, type BudgetOverflow } from './overflow.ts'

export { Config, name }
export {
  discoverBaselineInstructionFiles,
  loadBaselineInstructions,
} from './files.ts'
export type {
  InstructionFile,
  LoadedInstructionFile,
} from './files.ts'
export { renderWorkspaceContext } from './render.ts'
export type { RenderedWorkspaceContext, TruncatedInstruction } from './render.ts'

function visibleBaselineMessage(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): UserMessage | undefined {
  for (const message of authorityMessages.toReversed()) {
    if (message.source.kind === 'agent-instructions' && message.source.baseline === true) return message
  }
  for (const seq of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.events[seq]
    if (event?.type === 'user/message'
      && event.data.source.kind === 'agent-instructions'
      && event.data.source.baseline === true) return event.data
  }
  return undefined
}

function visibleBaselineSource(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): AgentInstructionSource | undefined {
  const source = visibleBaselineMessage(agent, authorityMessages)?.source
  return source?.kind === 'agent-instructions' ? source : undefined
}

function carriesBudgetMarker(message: UserMessage, maxBytes: number): boolean {
  return JSON.stringify(message.content).includes(`Workspace instruction budget ${maxBytes} bytes:`)
}

function isWorkspaceContext(message: UserMessage): boolean {
  return message.source.kind === 'agent-instructions'
}

function sameContextPayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}

const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])

function filePathFromExecution(exec: ToolExecution): string | undefined {
  if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  if (!('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string') return undefined
  const filePath = exec.arguments.file_path.trim()
  return filePath.length > 0 ? filePath : undefined
}

const DYNAMIC_OVERFLOW_KEY = 'dynamic-transition'

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const instructionVersions: InstructionVersionCache = new WeakMap()
  const baselinePreparations = new WeakMap<Session, {
    identity: string
    excludedScopes: ReadonlySet<string>
  }>()
  // Overflow reporting is once per session, per source and outcome: the baseline
  // recomposes every pre-step until visible, and a pass that fits clears the
  // source so a recurrence is reported again. `pendingNotices` holds the notice
  // owed by a source (baseline identity or dynamic transitions) until it enters.
  const reportedOverflow = new WeakMap<Session, Map<string, string>>()
  const pendingNotices = new WeakMap<Session, Map<string, UserMessage>>()
  const reportOverflow = (
    session: Session,
    key: string,
    overflow: BudgetOverflow | undefined,
  ): void => {
    const seen = reportedOverflow.get(session) ?? new Map<string, string>()
    reportedOverflow.set(session, seen)
    if (overflow === undefined) {
      // A pass that fits ends the outcome, so the same overflow later is news
      // again, and a notice still parked for it would describe a stale overflow.
      seen.delete(key)
      pendingNotices.get(session)?.delete(key)
      return
    }
    if (seen.get(key) === overflow.logLine) return
    seen.set(key, overflow.logLine)
    ctx.logger.warn('%s', overflow.logLine)
    const notices = pendingNotices.get(session) ?? new Map<string, UserMessage>()
    notices.set(key, overflow.notice)
    pendingNotices.set(session, notices)
  }
  // A parked baseline notice belongs to one baseline identity; a cwd or config
  // change makes it unreachable, so drop it instead of leaking it.
  const purgeStaleNotices = (session: Session, identity: string): void => {
    const notices = pendingNotices.get(session)
    if (notices === undefined) return
    for (const key of notices.keys()) {
      if (key !== DYNAMIC_OVERFLOW_KEY && key !== identity) notices.delete(key)
    }
  }
  const projectionLifecycle = new AbortController()
  type ProjectionTouch = { agent: Agent; path: string }
  const executionTouches = new Map<ToolExecutionToken, ProjectionTouch[]>()
  ctx.effect(
    () => () => {
      projectionLifecycle.abort(new Error('agent-instructions disposed'))
      executionTouches.clear()
    },
    'agent-instructions.projectionLifecycle',
  )
  // Emit listeners are not awaited, so each projection must compose against the
  // inbox produced by earlier file results for the same agent.
  const projectionTails = new WeakMap<Agent, Promise<void>>()
  // Execution ancestry and the enclosing durable step are the two commit
  // boundaries before an asynchronous projection may mutate the agent inbox.
  const openSteps = new WeakMap<Session, boolean>()
  const stepTouches = new WeakMap<Session, ProjectionTouch[]>()

  const compose = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    pending: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<UserMessage | undefined> => {
    signal.throwIfAborted()
    if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) {
      return undefined
    }
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return undefined
    if (touchedPaths.length === 0 && pending.length > 0) return pending[0]
    const content: UserMessage['content'][number][] = []
    const changes: AgentInstructionChange[] = []
    let desiredBaseline = false
    const authorityMessages = [...claimed]
    /* v8 ignore next -- normal agents carry an absolute session cwd. */
    const cwd = agent.session.header.cwd ?? process.cwd()
    const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, signal)
    const identity = workspaceBaselineIdentity(resolved, cwd, projectRoot)
    const visibleBaseline = visibleBaselineSource(agent, authorityMessages)
    const baselinePresent = visibleBaseline !== undefined
    const keepVisibleBaseline = visibleBaseline?.baselineIdentity === identity
    purgeStaleNotices(agent.session, identity)
    const prepared = baselinePreparations.get(agent.session)
    let excludedBaselineScopes = keepVisibleBaseline && prepared?.identity === identity
      ? prepared.excludedScopes
      : undefined
    let nextPreparation: { identity: string; excludedScopes: ReadonlySet<string> } | undefined
    if (!baselinePresent || !keepVisibleBaseline || excludedBaselineScopes === undefined) {
      const replacePreviousBaseline = baselinePresent && !keepVisibleBaseline
      const instructions = await loadBaselineInstructionSet({
        cwd,
        dshHome: resolved.dshHome,
        projectRootMarkers: resolved.projectRootMarkers,
        maxBytes: resolved.maxBytes,
        maxSourceBytes: resolved.maxSourceBytes,
        instructionFileCandidates: resolved.instructionFileCandidates,
        localInstructionFileCandidates: resolved.localInstructionFileCandidates,
        projectRoot,
        replacePreviousBaseline,
        signal,
      }, fileSystem)
      const overflow = instructions === undefined
        ? undefined
        : describeBudgetOverflow(instructions.rendered, instructions.observed, resolved.maxBytes)
      // A resumed visible baseline whose own in-text marker already records an
      // overflow was announced when it first entered (log and notice); announcing
      // it again from a fresh process would repeat that outcome.
      const visibleMessage = keepVisibleBaseline
        ? visibleBaselineMessage(agent, authorityMessages)
        : undefined
      const alreadyAnnounced = visibleMessage !== undefined
        && carriesBudgetMarker(visibleMessage, resolved.maxBytes)
      reportOverflow(agent.session, identity, alreadyAnnounced ? undefined : overflow)
      const baseline = baselineInstructionState(instructions?.included ?? [])
      const observedBaseline = baselineInstructionState(instructions?.observed ?? [])
      const excludedScopes = new Set(observedBaseline.changes.keys())
      for (const scope of baseline.changes.keys()) excludedScopes.delete(scope)
      excludedBaselineScopes = excludedScopes
      nextPreparation = { identity, excludedScopes }
      let versionStates = instructionVersions.get(agent.session)
      if (versionStates === undefined && baseline.versions.size > 0) {
        versionStates = new Map()
        instructionVersions.set(agent.session, versionStates)
      }
      for (const [scope, state] of baseline.versions) versionStates?.set(scope, state)
      if (!keepVisibleBaseline && instructions !== undefined && instructions.rendered.text.length > 0) {
        const baselineContent = workspaceContextMessage(instructions.rendered.text).content
        content.push(...baselineContent)
        const replacementScopes = new Set(baseline.changes.keys())
        const replacementRemovals = replacePreviousBaseline
          ? visibleBaseline.changes.flatMap(change => (
            change.action === 'remove' || replacementScopes.has(change.scope)
              ? []
              : [{ action: 'remove' as const, scope: change.scope, path: change.path }]
          ))
          : []
        const baselineChanges = [...replacementRemovals, ...baseline.changes.values()]
        changes.push(...baselineChanges)
        authorityMessages.push(createUserMessage({
          content: baselineContent,
          source: {
            kind: 'agent-instructions',
            form: 'instructions',
            baseline: true,
            baselineIdentity: identity,
            changes: baselineChanges,
          },
        }))
        desiredBaseline = true
      }
    }
    const update = await reconcileInstructionContext(
      agent,
      resolved,
      instructionVersions,
      fileSystem,
      {
        authorityMessages,
        scopeMessages: pending,
        includeBaselineScopes: keepVisibleBaseline,
        ...keepVisibleBaseline ? { excludedBaselineScopes } : {},
        touchedPaths,
        projectRoot,
        signal,
        onOverflow: (overflow) => { reportOverflow(agent.session, DYNAMIC_OVERFLOW_KEY, overflow) },
      },
    )
    if (update !== undefined) {
      content.push(...update.context.content)
      /* v8 ignore next -- reconciliation constructs only agent-instructions contexts. */
      if (update.context.source.kind === 'agent-instructions') {
        changes.push(...update.context.source.changes)
      }
      applyInstructionVersionUpdates(agent.session, update.versionUpdates, instructionVersions)
    }
    if (nextPreparation !== undefined) baselinePreparations.set(agent.session, nextPreparation)
    if (content.length === 0) return undefined
    return createUserMessage({
      content,
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        ...desiredBaseline ? { baseline: true } : {},
        ...desiredBaseline ? { baselineIdentity: identity } : {},
        changes,
      },
    })
  }

  const syncInbox = (agent: Agent, claimed: readonly UserMessage[], desired: UserMessage | undefined): void => {
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const alreadySupplied = desired !== undefined && (
      claimed.some(message => sameContextPayload(message, desired))
      || agent.session.surface.nodes.some((seq) => {
        const event = agent.session.events[seq]
        return event?.type === 'user/message' && sameContextPayload(event.data, desired)
      })
    )
    if (desired === undefined || alreadySupplied) {
      for (const message of pending) agent.inbox.remove(message.id)
      return
    }
    const reusable = pending.find(message => sameContextPayload(message, desired))
    if (reusable !== undefined) {
      for (const message of pending) {
        if (message !== reusable) agent.inbox.remove(message.id)
      }
      return
    }
    const replaced = pending[0]
    if (replaced === undefined) agent.inbox.prepend('next-step', desired)
    else agent.inbox.replace(replaced.id, desired)
    for (const message of pending.slice(1)) agent.inbox.remove(message.id)
  }

  const composeAndSync = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<void> => {
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const desired = await compose(agent, signal, claimed, pending, touchedPaths)
    signal.throwIfAborted()
    syncInbox(agent, claimed, desired)
  }

  const queueProjection = (
    agent: Agent,
    touchedPath: string,
  ): void => {
    const previous = projectionTails.get(agent) ?? Promise.resolve()
    const current = previous.then(() => composeAndSync(agent, projectionLifecycle.signal, [], [touchedPath]))
      .catch((error: unknown) => {
        if (!projectionLifecycle.signal.aborted) ctx.logger.warn('workspace instruction refresh failed: %o', error)
      })
    projectionTails.set(agent, current)
    void current.then(() => {
      if (projectionTails.get(agent) === current) projectionTails.delete(agent)
    })
  }

  const waitForProjections = async (agent: Agent): Promise<void> => {
    let projection: Promise<void> | undefined
    while ((projection = projectionTails.get(agent)) !== undefined) await projection
  }

  const stepIsOpen = (session: Session): boolean => {
    const known = openSteps.get(session)
    if (known !== undefined) return known
    let open = false
    for (const event of session.events) {
      if (event.type === 'step/start') open = true
      else if (event.type === 'step/end' || event.type === 'turn/end') open = false
    }
    openSteps.set(session, open)
    return open
  }

  const projectTouch = (touch: ProjectionTouch): void => {
    const session = touch.agent.session
    if (!stepIsOpen(session)) {
      queueProjection(touch.agent, touch.path)
      return
    }
    const pending = stepTouches.get(session)
    if (pending === undefined) stepTouches.set(session, [touch])
    else pending.push(touch)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start') {
      openSteps.set(session, true)
      return
    }
    if (event.type === 'turn/end') {
      openSteps.set(session, false)
      return
    }
    if (event.type !== 'step/end') return
    openSteps.set(session, false)
    const pending = stepTouches.get(session)
    if (pending === undefined) return
    stepTouches.delete(session)
    for (const touch of pending) queueProjection(touch.agent, touch.path)
  })

  // Place each pending overflow notice right after the context message it
  // describes: a baseline notice matches by baseline identity, a dynamic
  // transition notice by any agent-instructions message, or by the batch end when none is entering.
  const withOverflowNotice = (agent: Agent, messages: readonly UserMessage[]): readonly UserMessage[] => {
    const notices = pendingNotices.get(agent.session)
    if (notices === undefined) return messages
    let placed = messages
    for (const [key, notice] of notices) {
      const index = placed.findIndex(message => message.source.kind === 'agent-instructions'
        && (key === DYNAMIC_OVERFLOW_KEY
          || (message.source.baseline === true && message.source.baselineIdentity === key)))
      // A notice with no entering anchor (dynamic transitions all dropped, or a
      // baseline that was already visible) is still owed; it rides the batch end.
      notices.delete(key)
      placed = placed.toSpliced(index < 0 ? placed.length : index + 1, 0, notice)
    }
    return placed
  }

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    await waitForProjections(agent)
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const desired = await compose(agent, signal, messages, pending)
    signal.throwIfAborted()
    // An empty first entry owns a no-step turn; keep context pending instead
    // of turning it into a standalone request. Later entries may be tool continuations.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
      syncInbox(agent, messages, desired)
      return decision
    }
    // A proceeding step settles the pending context: it either enters below as
    // `desired`, or its payload is already covered by the batch, so nothing stays pending.
    for (const message of pending) agent.inbox.remove(message.id)
    // Fold new context right after the claimed batch, so the direct prompt
    // precedes it and the driver-appended runtime context follows it. A
    // baseline queued by an earlier step may arrive already covered, but its
    // overflow notice can still be owed.
    const folded = desired === undefined || decision.messages.some(message => sameContextPayload(message, desired))
      ? decision.messages
      : decision.messages.toSpliced(decision.messages.findLastIndex(message => messages.includes(message)) + 1, 0, desired)
    const noticed = withOverflowNotice(agent, folded)
    return noticed === decision.messages ? decision : { kind: 'enter', messages: [...noticed] }
  })

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    const touches = executionTouches.get(exec.token) ?? []
    executionTouches.delete(exec.token)
    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
      const ownPath = filePathFromExecution(exec)
      if (ownPath !== undefined) touches.push({ agent: exec.agent, path: ownPath })
    }
    if (exec.parent !== undefined) {
      if (touches.length > 0) {
        const parentTouches = executionTouches.get(exec.parent)
        if (parentTouches === undefined) executionTouches.set(exec.parent, touches)
        else parentTouches.push(...touches)
      }
      return
    }
    for (const touch of touches) projectTouch(touch)
  })
}
