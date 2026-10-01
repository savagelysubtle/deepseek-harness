// @vitest-environment jsdom
/**
 * usePinnedBrowserLanguages's own contract: pins navigator.language/languages
 * for the calling describe block's tests, then restores the environment's own
 * values (jsdom's `en-US`) once that block ends.
 */

import { describe, expect, it } from 'vitest'
import { usePinnedBrowserLanguages } from '../src/locale-env.ts'

describe('usePinnedBrowserLanguages', () => {
  const original = navigator.language

  describe('inside a suite that pins the language', () => {
    usePinnedBrowserLanguages('zh-CN', 'fr-FR')

    it('reports the pinned primary language and the full preference list', () => {
      expect(navigator.language).toBe('zh-CN')
      expect(navigator.languages).toEqual(['zh-CN', 'fr-FR'])
    })
  })

  it("restores the environment's own navigator.language once the pinned suite ends", () => {
    expect(navigator.language).toBe(original)
  })
})
