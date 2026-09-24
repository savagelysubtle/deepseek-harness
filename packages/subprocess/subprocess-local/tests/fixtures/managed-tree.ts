import { spawn } from 'node:child_process'
import { rename, writeFile } from 'node:fs/promises'

const [statePath] = process.argv.slice(2)
if (statePath === undefined) throw new Error('usage: managed-tree.ts <state-path>')

process.on('SIGTERM', () => {})
process.on('SIGHUP', () => {})
const descendant = spawn(process.execPath, [
  '-e',
  'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},60_000)',
], { stdio: 'ignore' })
if (descendant.pid === undefined) throw new Error('managed descendant did not publish a pid')

// Readers poll for this file's existence, then read it once. A plain writeFile lets a reader
// observe the path after creation but before the content lands, so write to a temp name in the
// same directory (same filesystem, so rename is atomic) and rename it into place: readers then
// see either no file or a complete one, never a partial write in progress.
const tmpStatePath = `${statePath}.${process.pid}.tmp`
await writeFile(tmpStatePath, JSON.stringify({ root: process.pid, descendant: descendant.pid }))
await rename(tmpStatePath, statePath)
setInterval(() => {}, 60_000)
