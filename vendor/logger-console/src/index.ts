import { Formatter, Message } from '@deepseek-ai/cordis'
import { inspect } from 'node:util'
import supportsColor from 'supports-color'
import { ConsoleExporter as Base } from './shared.ts'

/** Re-export shared console exporter config and base implementation. */
export * from './shared.ts'

const inspectFormatter: Formatter = (value, target) => {
  return inspect(value, { colors: !!target.colors, depth: Infinity, compact: true, breakLength: Infinity })
}

/**
 * Node console exporter with `util.inspect` object formatting.
 *
 * Writes every rendered line to stderr, not stdout (SWD-151): a headless or
 * scripted `dsh` run treats stdout as its task/data output channel, and an
 * operator-facing log line (info, warn, error) interleaved with that payload
 * makes it unparseable by any downstream consumer piping stdout. Color
 * support is therefore also detected against stderr rather than stdout, so a
 * piped stdout with a TTY stderr still renders colors, and a piped stderr
 * loses them, matching where the bytes actually land.
 */
export class ConsoleExporter extends Base {
  formatters: Record<string, Formatter> = {
    o: inspectFormatter,
    O: inspectFormatter,
  }

  getDefaults() {
    return {
      ...super.getDefaults(),
      colors: (supportsColor.stderr ? supportsColor.stderr.level : 0) as false | 0 | 1 | 2 | 3,
    }
  }

  export(message: Message) {
    process.stderr.write(this.render(message) + '\n')
  }
}

export default ConsoleExporter
