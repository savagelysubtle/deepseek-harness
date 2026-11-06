import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsdown'

const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
} as const

/**
 * Two separate bundles: the package entries, and the seat-guard hook as ONE self-contained
 * plain-JavaScript file (no shared chunks), because the hook runs as `node lib/seat-guard.js` from
 * an installed package where Node refuses to strip TypeScript.
 */
export default defineConfig([
  { ...shared, entry: ['lib/types/index.js', 'lib/types/invariant.js'] },
  {
    ...shared,
    entry: { 'seat-guard': 'lib/types/bin.js' },
    // The host attests the guard and refuses a group- or world-writable file; tsdown writes with the
    // builder's umask (664 under 002), so pin the mode here instead of depending on the machine.
    onSuccess: () => { chmodSync(join(import.meta.dirname, 'lib', 'seat-guard.js'), 0o644) },
  },
])
