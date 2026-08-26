/**
 * Function-plugin face of the local memory provider, sized for composition
 * rows (`cordis.yml` / agent presets): named exports only, wrapping
 * {@link LocalMemoryProvider}'s class registration. The class keeps its own
 * module for programmatic construction and tests.
 * @module @deepseek-ai/dsh-memory/local-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalMemoryProvider } from './local.ts'
import type { Config as LocalConfig } from './local.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory-local'

/** Services required before this plugin mounts. */
export const inject = []

/** Schemastery configuration for the local provider. */
export const Config: z<LocalConfig> = z.object({
  root: z.string(),
})

/**
 * Mount the local memory provider: constructs the service class so its
 * defaults resolve through the same path programmatic users exercise.
 * @param ctx - context that publishes the `memory` service key.
 * @param config - optional storage-root override.
 * @returns resolves once the provider fiber is live.
 */
export async function apply(ctx: Context, config?: LocalConfig): Promise<void> {
  await ctx.plugin(LocalMemoryProvider, config ?? {})
}
