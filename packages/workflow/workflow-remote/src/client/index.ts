/**
 * Browser-safe face of the `workflow` Remote contract: the wire types, the error-code and event-name
 * constants, the lease timings, `WORKFLOW_LOOPBACK_ONLY_MESSAGE`, `explainWorkflowRefusal` and
 * `explainWorkflowRejection`. It re-exports `../wire.ts` only, which has no value imports, so no node,
 * filesystem or Host module is reachable from it. Client bundles import
 * `@deepseek-ai/dsh-workflow-remote/client`.
 *
 * Real call shapes (what a UI sees on `ctx.remote.workflow.<method>`):
 * - Success: `{ ok: true, value: { ok: true, ...result } }` (the carrier wraps the method result).
 *   Example: `{ ok: true, value: { ok: true, leaseId: 'ab12...', ttlMs: 45000, workspaceKey: '0f3a...' } }`.
 * - Host-reported failure: `{ ok: true, value: { ok: false, error: 'NOT_FOUND', message: '...' } }`; the
 *   field is `error` (a `WorkflowErrorCode`), never `code`.
 * - Carrier failure (403 on a privileged method, network): `{ ok: false, error: { message: '... HTTP 403 ...' } }`
 *   or a rejection; pass it to `explainWorkflowRejection('workflow/save', cause)`.
 * - `validate` takes only `{ text, name? }`: no session argument.
 */
export * from '../wire.ts'
