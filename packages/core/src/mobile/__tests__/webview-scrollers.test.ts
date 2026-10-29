// A swipe pairs before and after scrollers by id, never by position.

import { describe, it, expect } from 'vitest'
import { parseWebViewScrollers, webViewSwipeSignal } from '../webview-scrollers.js'
import type { IdentifiedScrollOffsets } from '../webview-scrollers.js'

const doc = (y: number, maxY: number, x = 0, maxX = 0): IdentifiedScrollOffsets => ({ id: 'document', x, y, maxX, maxY })
const el = (id: string, y: number, maxY: number, x = 0, maxX = 0): IdentifiedScrollOffsets => ({ id, x, y, maxX, maxY })
const A = '0/1/2|div#a.'
const B = '0/1/3|div#b.'

describe('WebView scroller members are paired by identity', () => {
  it('identical membership is judged by the scroller-set rule', () => {
    expect(webViewSwipeSignal('down', [doc(0, 700), el(A, 0, 1200)], [doc(0, 700), el(A, 400, 1200)])).toBe('moved')
    expect(webViewSwipeSignal('down', [doc(700, 700), el(A, 1200, 1200)], [doc(700, 700), el(A, 1200, 1200)])).toBe('at-boundary')
    expect(webViewSwipeSignal('up', [doc(0, 700), el(A, 0, 1200)], [doc(0, 700), el(A, 0, 1200)])).toBe('at-boundary')
    expect(webViewSwipeSignal('down', [doc(700, 700), el(A, 300, 1200)], [doc(700, 700), el(A, 300, 1200)])).toBe('unknown')
    expect(webViewSwipeSignal('down', [doc(0, 0)], [doc(0, 0)])).toBe('unknown')
    expect(webViewSwipeSignal('right', [doc(0, 0, 500, 500)], [doc(0, 0, 500, 500)])).toBe('at-boundary')
  })

  it('a changed membership is moved only when a common member moved', () => {
    expect(webViewSwipeSignal('down', [doc(0, 700), el(A, 0, 1200)], [doc(300, 700), el(B, 0, 1200)])).toBe('moved')
    expect(webViewSwipeSignal('down', [doc(700, 700), el(A, 1200, 1200)], [doc(700, 700), el(B, 1200, 1200)])).toBe('unknown')
    expect(webViewSwipeSignal('down', [doc(700, 700)], [doc(700, 700), el(B, 1200, 1200)])).toBe('unknown')
    expect(webViewSwipeSignal('down', [doc(700, 700), el(A, 1200, 1200)], [doc(700, 700)])).toBe('unknown')
    // No member in common proves nothing, even when the new member sits off its start.
    expect(webViewSwipeSignal('down', [el(A, 0, 1200)], [el(B, 600, 1200)])).toBe('unknown')
  })

  it('null, empty, malformed or duplicate reads are unknown', () => {
    expect(parseWebViewScrollers(null)).toBeUndefined()
    expect(parseWebViewScrollers([])).toBeUndefined()
    expect(parseWebViewScrollers(doc(0, 700))).toBeUndefined()
    expect(parseWebViewScrollers([doc(0, 700), el(A, 0, 1200), el(A, 0, 1200)])).toBeUndefined()
    expect(parseWebViewScrollers([doc(0, 700), { x: 0, y: 0, maxX: 0, maxY: 1200 }])).toBeUndefined()
    expect(parseWebViewScrollers([doc(0, 700), { id: '', x: 0, y: 0, maxX: 0, maxY: 1200 }])).toBeUndefined()
    expect(parseWebViewScrollers([doc(0, 700), { id: A, x: 0, y: '0', maxX: 0, maxY: 1200 }])).toBeUndefined()
    expect(parseWebViewScrollers([doc(Number.NaN, 700)])).toBeUndefined()
    expect(parseWebViewScrollers([doc(0, 700), null])).toBeUndefined()
    expect(parseWebViewScrollers([doc(0, 700), el(A, 0, 1200)])).toEqual([doc(0, 700), el(A, 0, 1200)])

    expect(webViewSwipeSignal('down', undefined, [doc(700, 700)])).toBe('unknown')
    expect(webViewSwipeSignal('down', [doc(700, 700)], undefined)).toBe('unknown')
    expect(webViewSwipeSignal('down', [], [])).toBe('unknown')
    const dup = [doc(700, 700), el(A, 1200, 1200), el(A, 1200, 1200)]
    expect(webViewSwipeSignal('down', dup, dup)).toBe('unknown')
    const bad = [doc(700, 700), { id: A, x: 0, y: Number.POSITIVE_INFINITY, maxX: 0, maxY: 1200 }]
    expect(webViewSwipeSignal('down', bad, bad)).toBe('unknown')
  })

  it('members are aligned by id whatever their order', () => {
    expect(webViewSwipeSignal(
      'down',
      [doc(700, 700), el(A, 1200, 1200), el(B, 0, 1200)],
      [el(B, 300, 1200), doc(700, 700), el(A, 1200, 1200)],
    )).toBe('moved')
    expect(webViewSwipeSignal(
      'down',
      [doc(700, 700), el(A, 1200, 1200), el(B, 1200, 1200)],
      [el(B, 1200, 1200), el(A, 1200, 1200), doc(700, 700)],
    )).toBe('at-boundary')
    // Index pairing would compare `a` (1200) with `b` (0) and read moved.
    expect(webViewSwipeSignal(
      'down',
      [doc(700, 700), el(A, 1200, 1200), el(B, 0, 1200)],
      [doc(700, 700), el(B, 0, 1200), el(A, 1200, 1200)],
    )).toBe('unknown')
  })
})
