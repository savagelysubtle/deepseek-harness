/**
 * Cross-guard ordering invariant.
 *
 * `repeat-tool-reminder` and the agent loop's `ToolRepeatDetector` watch the
 * same signal — a tool call repeating with no state change — and they are one
 * escalation ladder, not two competing systems: nudge gently, nudge in detail,
 * and only then abort the turn.
 *
 * That ordering lives in two packages that cannot import each other's runtime,
 * so nothing structurally prevents someone from lowering the abort threshold or
 * raising a reminder tier until they overlap. When they do overlap the abort
 * fires first and every reminder becomes unreachable dead code — a silent
 * regression that no type check or lint can see. This test is the enforcement
 * point: change either number and it fails here, loudly, naming both values.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOL_REPEAT_THRESHOLD } from '@deepseek-ai/dsh-agent-loop'
import { DEFAULT_REMINDER_THRESHOLDS } from '../src/index.ts'

describe('reminder-then-abort ordering', () => {
  const reminderThresholds = DEFAULT_REMINDER_THRESHOLDS

  it('aborts strictly after every reminder tier, never at or before one', () => {
    const highestReminder = Math.max(...reminderThresholds)
    expect(
      DEFAULT_TOOL_REPEAT_THRESHOLD,
      `the loop-guard abort threshold (${DEFAULT_TOOL_REPEAT_THRESHOLD}) must sit strictly above `
      + `the highest repeat-tool-reminder tier (${highestReminder}); at or below it, the turn is `
      + 'aborted before the reminders can escalate and the reminder guard becomes dead code',
    ).toBeGreaterThan(highestReminder)
  })

  it('leaves every reminder tier reachable before the abort', () => {
    for (const tier of reminderThresholds) {
      expect(tier, `reminder tier ${tier} is unreachable — the abort fires at ${DEFAULT_TOOL_REPEAT_THRESHOLD}`)
        .toBeLessThan(DEFAULT_TOOL_REPEAT_THRESHOLD)
    }
  })
})
