import { describe, expect, it } from 'vitest'
import { API_REMOTE_FORWARDED_EVENTS } from '@deepseek-ai/dsh-api-remotes'

describe('API_REMOTE_FORWARDED_EVENTS', () => {
  it('forwards mcp/status-changed so a Settings Tools panel can subscribe without a bespoke RPC', () => {
    expect(API_REMOTE_FORWARDED_EVENTS).toContain('mcp/status-changed')
  })

  it('declares no duplicate event names', () => {
    expect(new Set(API_REMOTE_FORWARDED_EVENTS).size).toBe(API_REMOTE_FORWARDED_EVENTS.length)
  })
})
