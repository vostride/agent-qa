import { describe, it, expect } from 'vitest'
import {
  readFillRefusalMeta,
  readFillSubmitMeta,
  readFillVerdictMeta,
  readScrollUntilVisibleMeta,
  readShellActionMeta,
  SCROLL_OUTCOMES_READ_ONLY,
  SCROLL_OUTCOMES_WRITTEN,
} from '../metadata.js'

const carrier = (metadata: Record<string, unknown>) => ({ metadata })

describe('readFillRefusalMeta', () => {
  it('returns the typed block for well-formed input', () => {
    expect(
      readFillRefusalMeta(carrier({ fillRefusal: { verb: 'fill', cause: 'not-editable', evidence: 'no-editable-signal' } })),
    ).toEqual({ verb: 'fill', cause: 'not-editable', evidence: 'no-editable-signal' })
    expect(
      readFillRefusalMeta(carrier({ fillRefusal: { verb: 'clearText', cause: 'target-not-found', evidence: 'stale-target' } })),
    ).toEqual({ verb: 'clearText', cause: 'target-not-found', evidence: 'stale-target' })
    for (const evidence of ['no-keyboard-focus', 'focus-elsewhere']) {
      expect(readFillRefusalMeta(carrier({ fillRefusal: { verb: 'fill', cause: 'not-editable', evidence } }))?.evidence).toBe(evidence)
    }
  })

  it('reads the single-line refusal pair (refuse before typing)', () => {
    expect(
      readFillRefusalMeta(carrier({ fillRefusal: { verb: 'fill', cause: 'single-line-field', evidence: 'text-has-line-breaks' } })),
    ).toEqual({ verb: 'fill', cause: 'single-line-field', evidence: 'text-has-line-breaks' })
  })

  it('returns undefined on any shape miss', () => {
    expect(readFillRefusalMeta(undefined)).toBeUndefined()
    expect(readFillRefusalMeta({})).toBeUndefined()
    expect(readFillRefusalMeta(carrier({}))).toBeUndefined()
    expect(readFillRefusalMeta(carrier({ fillRefusal: 'not-editable' }))).toBeUndefined()
    expect(readFillRefusalMeta(carrier({ fillRefusal: { verb: 'tap', cause: 'not-editable', evidence: 'stale-target' } }))).toBeUndefined()
    expect(readFillRefusalMeta(carrier({ fillRefusal: { verb: 'fill', cause: 'busy', evidence: 'stale-target' } }))).toBeUndefined()
    expect(readFillRefusalMeta(carrier({ fillRefusal: { verb: 'fill', cause: 'not-editable', evidence: 'other' } }))).toBeUndefined()
    expect(readFillRefusalMeta(carrier({ fillRefusal: { verb: 'fill', cause: 'not-editable', evidence: 1 } }))).toBeUndefined()
    expect(readFillRefusalMeta(carrier({ fillRefusal: { cause: 'not-editable', evidence: 'stale-target' } }))).toBeUndefined()
  })
})

describe('readFillSubmitMeta', () => {
  it('returns the typed block for well-formed input', () => {
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: true } }))).toEqual({ sent: true })
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: false } }))).toEqual({ sent: false })
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: false, reason: 'multi-line-field' } }))).toEqual({
      sent: false,
      reason: 'multi-line-field',
    })
  })

  it('returns undefined on any shape miss', () => {
    expect(readFillSubmitMeta(undefined)).toBeUndefined()
    expect(readFillSubmitMeta(carrier({}))).toBeUndefined()
    expect(readFillSubmitMeta(carrier({ fillSubmit: true }))).toBeUndefined()
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: 'yes' } }))).toBeUndefined()
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: false, reason: 'other' } }))).toBeUndefined()
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: false, reason: 3 } }))).toBeUndefined()
  })

  it('reads the fillSubmit outcome shapes', () => {
    const cases: Record<string, unknown>[] = [
      { sent: true, outcome: 'sent' },
      { sent: false, outcome: 'not-sent', reason: 'mismatch' },
      { sent: false, outcome: 'not-sent', reason: 'input-failed' },
      { sent: false, outcome: 'not-sent', reason: 'multi-line-field' },
      { sent: false, outcome: 'unavailable', detail: 'adb_shell not enabled' },
      { sent: false, outcome: 'failed', detail: 'socket hang up' },
    ]
    for (const block of cases) {
      expect(readFillSubmitMeta(carrier({ fillSubmit: block }))).toEqual(block)
    }
  })

  it('reads a focus lost hold', () => {
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: false, reason: 'focus-lost' } }))).toEqual({
      sent: false,
      reason: 'focus-lost',
    })
  })

  it('rejects an unknown outcome or reason, and a sent that contradicts the outcome', () => {
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: false, outcome: 'skipped' } }))).toBeUndefined()
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: false, outcome: 'not-sent', reason: 'busy' } }))).toBeUndefined()
    for (const outcome of ['not-sent', 'unavailable', 'failed']) {
      expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: true, outcome } }))).toBeUndefined()
    }
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: false, outcome: 'sent' } }))).toBeUndefined()
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: true, reason: 'mismatch' } }))).toBeUndefined()
    expect(readFillSubmitMeta(carrier({ fillSubmit: { sent: false, outcome: 'failed', detail: 7 } }))).toBeUndefined()
  })
})

describe('readShellActionMeta', () => {
  it('reads an unavailable keyevent and a failed openQuickSettings', () => {
    expect(
      readShellActionMeta(carrier({ shellAction: { verb: 'keyevent', outcome: 'unavailable', reason: 'adb-shell-disabled' } })),
    ).toEqual({ verb: 'keyevent', outcome: 'unavailable', reason: 'adb-shell-disabled' })
    expect(
      readShellActionMeta(carrier({ shellAction: { verb: 'openQuickSettings', outcome: 'failed', detail: 'device offline' } })),
    ).toEqual({ verb: 'openQuickSettings', outcome: 'failed', detail: 'device offline' })
  })

  it('rejects anything else', () => {
    expect(readShellActionMeta(undefined)).toBeUndefined()
    expect(readShellActionMeta(carrier({}))).toBeUndefined()
    expect(readShellActionMeta(carrier({ shellAction: 'unavailable' }))).toBeUndefined()
    expect(readShellActionMeta(carrier({ shellAction: { verb: 'tap', outcome: 'failed' } }))).toBeUndefined()
    expect(readShellActionMeta(carrier({ shellAction: { verb: 'keyevent', outcome: 'sent' } }))).toBeUndefined()
    expect(readShellActionMeta(carrier({ shellAction: { verb: 'keyevent', outcome: 'unavailable', reason: 'other' } }))).toBeUndefined()
    expect(readShellActionMeta(carrier({ shellAction: { verb: 'keyevent', outcome: 'failed', detail: 1 } }))).toBeUndefined()
    expect(readShellActionMeta(carrier({ shellAction: { outcome: 'failed' } }))).toBeUndefined()
  })
})

describe('readFillVerdictMeta', () => {
  it('reads every verdict for both verbs, with and without path and secure', () => {
    for (const verb of ['fill', 'clearText'] as const) {
      for (const verdict of ['exact', 'normalized', 'mismatch', 'unverified'] as const) {
        expect(readFillVerdictMeta(carrier({ fillVerdict: { verb, verdict } }))).toEqual({ verb, verdict })
        for (const path of ['native', 'webview', 'keyboard'] as const) {
          expect(readFillVerdictMeta(carrier({ fillVerdict: { verb, verdict, path } }))).toEqual({ verb, verdict, path })
        }
      }
    }
    expect(
      readFillVerdictMeta(carrier({ fillVerdict: { verb: 'fill', verdict: 'unverified', secure: true } })),
    ).toEqual({ verb: 'fill', verdict: 'unverified', secure: true })
    expect(
      readFillVerdictMeta(carrier({ fillVerdict: { verb: 'fill', verdict: 'unverified', path: 'keyboard', secure: true } })),
    ).toEqual({ verb: 'fill', verdict: 'unverified', path: 'keyboard', secure: true })
  })

  it('rejects an unknown verdict, verb or path, and any other shape miss', () => {
    expect(readFillVerdictMeta(undefined)).toBeUndefined()
    expect(readFillVerdictMeta(carrier({}))).toBeUndefined()
    expect(readFillVerdictMeta(carrier({ fillVerdict: 'exact' }))).toBeUndefined()
    expect(readFillVerdictMeta(carrier({ fillVerdict: { verb: 'fill', verdict: 'verified' } }))).toBeUndefined()
    expect(readFillVerdictMeta(carrier({ fillVerdict: { verb: 'tap', verdict: 'exact' } }))).toBeUndefined()
    expect(readFillVerdictMeta(carrier({ fillVerdict: { verb: 'fill', verdict: 'exact', path: 'ime' } }))).toBeUndefined()
    expect(readFillVerdictMeta(carrier({ fillVerdict: { verb: 'fill', verdict: 'exact', secure: 'yes' } }))).toBeUndefined()
    expect(readFillVerdictMeta(carrier({ fillVerdict: { verdict: 'exact' } }))).toBeUndefined()
  })
})

describe('readScrollUntilVisibleMeta', () => {
  it('readScrollUntilVisibleMeta reads historical no-change and cap', () => {
    expect(readScrollUntilVisibleMeta(carrier({ scrollUntilVisible: { swipes: 3, reversedOnce: false, outcome: 'no-change' } }))).toEqual({
      swipes: 3,
      reversedOnce: false,
      outcome: 'no-change',
    })
    expect(readScrollUntilVisibleMeta(carrier({ scrollUntilVisible: { swipes: 20, reversedOnce: true, outcome: 'cap' } }))).toEqual({
      swipes: 20,
      reversedOnce: true,
      outcome: 'cap',
    })
    expect(SCROLL_OUTCOMES_READ_ONLY).toEqual(['no-change', 'cap'])
  })

  it('reads the new outcome and endedBy', () => {
    expect(SCROLL_OUTCOMES_WRITTEN).toEqual(['found', 'not-found', 'unresolved'])
    const cases = [
      { outcome: 'found', endedBy: 'target-visible' },
      { outcome: 'found', endedBy: 'boundary' },
      { outcome: 'not-found', endedBy: 'boundary' },
      { outcome: 'unresolved', endedBy: 'max-swipes' },
    ]
    for (const c of cases) {
      const block = { swipes: 2, reversedOnce: false, ...c }
      expect(readScrollUntilVisibleMeta(carrier({ scrollUntilVisible: block }))).toEqual(block)
    }
  })

  it('returns undefined on any shape miss', () => {
    expect(readScrollUntilVisibleMeta(undefined)).toBeUndefined()
    expect(readScrollUntilVisibleMeta(carrier({}))).toBeUndefined()
    expect(readScrollUntilVisibleMeta(carrier({ scrollUntilVisible: { swipes: 1, reversedOnce: false, outcome: 'moved' } }))).toBeUndefined()
    expect(readScrollUntilVisibleMeta(carrier({ scrollUntilVisible: { swipes: '1', reversedOnce: false, outcome: 'found' } }))).toBeUndefined()
    expect(
      readScrollUntilVisibleMeta(carrier({ scrollUntilVisible: { swipes: 1, reversedOnce: false, outcome: 'found', endedBy: 'stall' } })),
    ).toBeUndefined()
  })
})
