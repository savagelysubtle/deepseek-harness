/**
 * Isolation assumption: parseArgs runs first and throws because the vitest
 * worker's own argv carries no `--url`/`--server-name`, so nothing downstream
 * (browser, network, $DSH_HOME) is ever reached.
 *
 * Covers auth-cli.ts's bin-execution guard (the `invoked` check at the bottom
 * of the module, gating `runAuthCli(process.argv.slice(2)).catch(...)`). That
 * branch only runs `true` when the module is its own process entry point
 * (`import.meta.url === pathToFileURL(process.argv[1]).href`) — which every
 * other spec's plain `import` never satisfies, by design (so importing the
 * CLI module in-process never starts a listener).
 *
 * This is the one file allowed to make `process.argv[1]` point at this
 * module before a FRESH, first-ever import of it, so the real entry-point
 * detection the module ships with fires for real — not a mock of it. Kept in
 * its own file so this is the only import of auth-cli.ts in the whole
 * isolated test-file module graph (vitest gives every spec file a fresh
 * module registry), and both `process.argv[1]` and `process.exitCode` are
 * restored before the test returns so nothing leaks into the rest of the run.
 */
import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

describe('auth-cli bin execution guard', () => {
  it('runs the catch handler and sets a failing exit code when invoked as the entry module', async () => {
    const modulePath = fileURLToPath(new URL('../src/auth-cli.ts', import.meta.url))
    const originalArgv1 = process.argv[1]
    const originalExitCode = process.exitCode
    const errors: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      errors.push(parts.map(part => String(part)).join(' '))
    })
    process.argv[1] = modulePath
    try {
      // Real argv (the vitest worker's own) reaches process.argv.slice(2)
      // here, same as a real script invocation would forward its own argv —
      // it will not satisfy parseArgs' required --url/--server-name, so the
      // module's own catch handler deterministically logs and fails.
      await import('../src/auth-cli.ts')
      await vi.waitFor(() => {
        expect(errors.length).toBeGreaterThan(0)
      })
      expect(process.exitCode).toBe(1)
      expect(errors[0]).toMatch(/usage: dsh-mcp-client-auth|unknown or incomplete argument/)
    } finally {
      if (originalArgv1 === undefined) process.argv.splice(1, 1)
      else process.argv[1] = originalArgv1
      process.exitCode = originalExitCode
      errorSpy.mockRestore()
    }
  })
})
