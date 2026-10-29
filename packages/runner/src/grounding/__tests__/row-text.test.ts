// Observations are built by the shared builder from inline nodes.

import { describe, expect, it } from 'vitest'
import type { ElementInfo } from '@vostride/agent-qa-schema'
import {
  buildScreenState,
  judgeStatedTarget,
  rowContains,
  rowTextOf,
  wordTokens,
  type InterimNode,
} from '../../index.js'
import { strictMatch } from '../strict-match.js'

function elementsOf(nodes: InterimNode[]): ElementInfo[] {
  return buildScreenState({
    platform: 'web',
    nodes,
    viewport: { width: 400, height: 800 },
    scroll: { offsetX: 0, offsetY: 0, contentWidth: 400, contentHeight: 800 },
    coordSpace: 'viewport',
    timestamp: 0,
  }).state.elements
}

function named(elements: ElementInfo[], name: string): ElementInfo {
  const element = elements.find((candidate) => candidate.name === name)
  if (element === undefined) throw new Error(`no element named ${name}`)
  return element
}

const ADDRESSES: InterimNode[] = [
  { role: 'listitem', text: 'Work 7 Elm Street, Springfield' },
  { role: 'button', name: 'Edit label', parentIndex: 0 },
  { role: 'listitem', text: 'Home 1 Home Street, Springfield' },
  { role: 'button', name: 'Edit label', parentIndex: 2 },
]

describe('row text and row containment', () => {
  it('the nearest row container wins over an outer cell', () => {
    const elements = elementsOf([
      { role: 'cell', name: 'Outer cell' },
      { role: 'listitem', text: 'Inner row', parentIndex: 0 },
      { role: 'button', name: 'Go', parentIndex: 1 },
    ])
    expect(rowTextOf(named(elements, 'Go'), elements)).toBe('Inner row Go')
  })

  it('a row container wins over a nearer cell', () => {
    const elements = elementsOf([
      { role: 'row', name: 'Green mug Remove' },
      { role: 'cell', name: 'Remove', parentIndex: 0 },
      { role: 'button', name: 'Remove', parentIndex: 1 },
    ])
    expect(rowTextOf(elements[2], elements)).toBe('Green mug Remove Remove Remove')
  })

  it('a cell is the container when no row container exists', () => {
    const elements = elementsOf([
      { role: 'cell', name: 'Address', text: '7 Elm Street' },
      { role: 'button', name: 'Edit label', parentIndex: 0 },
    ])
    expect(rowTextOf(named(elements, 'Edit label'), elements)).toBe(
      'Address 7 Elm Street Edit label',
    )
  })

  it('no container gives undefined', () => {
    const elements = elementsOf([
      { role: 'heading', name: 'Addresses' },
      { role: 'button', name: 'Edit label', parentIndex: 0 },
    ])
    expect(rowTextOf(named(elements, 'Edit label'), elements)).toBeUndefined()
  })

  it("the text order is the container's name, its text, then descendants in document order", () => {
    const elements = elementsOf([
      { role: 'row', name: 'R', text: 'T' },
      { role: 'cell', name: 'A', text: 'a1', parentIndex: 0 },
      { role: 'button', name: 'B', parentIndex: 1 },
      { role: 'cell', name: 'C', parentIndex: 0 },
      { role: 'row', name: 'Other' },
    ])
    expect(rowTextOf(named(elements, 'B'), elements)).toBe('R T A a1 B C')
  })

  it('a hierarchy cycle ends the walk', () => {
    const elements = elementsOf([{ role: 'button', name: 'Loop' }])
    const looped: ElementInfo = {
      ...elements[0],
      hierarchy: { parentRef: elements[0].ref },
    }
    expect(rowTextOf(looped, [looped])).toBeUndefined()
  })

  it("rowContains: 'Elm St' is in '7 Elm Street, Springfield'", () => {
    expect(rowContains('7 Elm Street, Springfield', 'Elm St')).toBe(true)
  })

  it("rowContains: 'Elm Street' is not in '1 Home Street, Springfield'", () => {
    expect(rowContains('1 Home Street, Springfield', 'Elm Street')).toBe(false)
  })

  it("rowContains: '7' is not in '17 Elm Street'", () => {
    expect(rowContains('17 Elm Street', '7')).toBe(false)
  })

  it("rowContains: 'Springfield 7 Elm' is in 'Work 7 Elm Street, Springfield'", () => {
    expect(rowContains('Work 7 Elm Street, Springfield', 'Springfield 7 Elm')).toBe(true)
  })

  it("rowContains: 'ELM' is in '7 Elm Street'", () => {
    expect(rowContains('7 Elm Street', 'ELM')).toBe(true)
  })

  it('rowContains: full-width digits match ASCII digits', () => {
    expect(rowContains('7 Elm Street', '７ Elm')).toBe(true)
    expect(wordTokens('１７ Elm')).toEqual(['17', 'elm'])
  })

  // Digit grouping is read once, in the shared tokenizer.
  it('wordTokens reads a digit group split by a comma, an underscore, a narrow no-break space or a no-break space as one number', () => {
    expect(wordTokens('1,234 1_234 1\u202F234 1\u00A0234')).toEqual([
      '1234',
      '1234',
      '1234',
      '1234',
    ])
  })

  it('rowContains reads "1,234" and "1234" as one number in both directions', () => {
    expect(rowContains('Invoice 1,234 due', 'Invoice 1234')).toBe(true)
    expect(rowContains('Invoice 1234 due', 'Invoice 1,234')).toBe(true)
  })

  it('wordTokens keeps a plain space, a dot and a short group as separators', () => {
    expect(wordTokens('1 234 1.234 1,23')).toEqual(['1', '234', '1', '234', '1', '23'])
  })

  it('rowContains: a one-letter word is never a prefix', () => {
    expect(rowContains('7 Elm Street', 'E')).toBe(false)
  })

  it("the judge treats a row of '' or '   ' as not stated", () => {
    const elements = elementsOf(ADDRESSES)
    for (const row of ['', '   ']) {
      const judgement = judgeStatedTarget(
        { role: 'button', name: 'Edit label', row },
        elements[3],
        elements,
      )
      expect(judgement).toMatchObject({ verdict: 'agrees', rowStated: false, rowKnown: true })
    }
  })

  it("the judge never adds 'row' when the row is unknown", () => {
    const elements = elementsOf([{ role: 'button', name: 'Edit label' }])
    const judgement = judgeStatedTarget(
      { role: 'button', name: 'Edit label', row: '7 Elm Street' },
      elements[0],
      elements,
    )
    expect(judgement).toEqual({ verdict: 'agrees', rowStated: true, rowKnown: false })
  })

  it('the judge refuses a stated row that is not the ref row and names the observed row', () => {
    const elements = elementsOf(ADDRESSES)
    const judgement = judgeStatedTarget(
      { role: 'button', name: 'Edit label', row: '7 Elm Street' },
      elements[3],
      elements,
    )
    expect(judgement).toEqual({
      verdict: 'contradicts',
      reasons: ['row'],
      rowStated: true,
      observedRow: 'Home 1 Home Street, Springfield Edit label',
    })
  })

  it('the judge returns the observed row when the row agrees', () => {
    const elements = elementsOf(ADDRESSES)
    expect(
      judgeStatedTarget({ role: 'button', name: 'Edit label', row: 'Elm St' }, elements[1], elements),
    ).toEqual({
      verdict: 'agrees',
      rowStated: true,
      rowKnown: true,
      observedRow: 'Work 7 Elm Street, Springfield Edit label',
    })
  })

  it("a row container is its own row: a listitem's row is its own text and descendants", () => {
    const elements = elementsOf([
      { role: 'listitem', text: 'Home 1 Home Street' },
      { role: 'button', name: 'Edit label', parentIndex: 0 },
    ])
    expect(rowTextOf(elements[0], elements)).toBe('Home 1 Home Street Edit label')
  })

  it('a cell with no row container above it is its own row', () => {
    const elements = elementsOf([{ role: 'cell', name: 'Address', text: '7 Elm Street' }])
    expect(rowTextOf(elements[0], elements)).toBe('Address 7 Elm Street')
  })

  it("the judge refuses a listitem stated with another row's words", () => {
    const elements = elementsOf(ADDRESSES)
    const judgement = judgeStatedTarget(
      { role: 'listitem', name: 'Address', row: '7 Elm Street' },
      elements[2],
      elements,
    )
    expect(judgement).toMatchObject({ verdict: 'contradicts', reasons: ['row'] })
    expect(judgement.observedRow).toContain('1 Home Street')
  })

  // A nested row container keeps its parent row's own line.
  const TREE: InterimNode[] = [
    { role: 'treeitem', name: '2024' },
    { role: 'treeitem', name: 'Invoices', parentIndex: 0 },
    { role: 'treeitem', name: '2025' },
    { role: 'treeitem', name: 'Invoices', parentIndex: 2 },
  ]

  it("a nested row container's row is its own line first, then its same-role parent row's line", () => {
    const elements = elementsOf(TREE)
    expect(rowTextOf(elements[3], elements)).toBe('Invoices 2025')
    expect(rowTextOf(elements[1], elements)).toBe('Invoices 2024')
  })

  it('the judge agrees with a nested treeitem stated with its parent row', () => {
    const elements = elementsOf(TREE)
    const judgement = judgeStatedTarget(
      { role: 'treeitem', name: 'Invoices', row: '2025' },
      elements[3],
      elements,
    )
    expect(judgement).toMatchObject({ verdict: 'agrees', rowStated: true, rowKnown: true })
  })

  it('strictMatch tells a nested treeitem from its twin under another parent', () => {
    const elements = elementsOf(TREE)
    expect(strictMatch({ role: 'treeitem', name: 'Invoices', row: '2025' }, elements)).toEqual({
      kind: 'resolved',
      ref: elements[3].ref,
    })
    const row = rowTextOf(elements[3], elements) ?? ''
    expect(strictMatch({ role: 'treeitem', name: 'Invoices', row }, elements)).toEqual({
      kind: 'resolved',
      ref: elements[3].ref,
    })
  })

  it("the judge refuses a nested treeitem stated with another parent's row", () => {
    const elements = elementsOf(TREE)
    const judgement = judgeStatedTarget(
      { role: 'treeitem', name: 'Invoices', row: '2025' },
      elements[1],
      elements,
    )
    expect(judgement).toMatchObject({ verdict: 'contradicts', reasons: ['row'] })
  })

  it("a nested row container's row does not take a sibling row's words", () => {
    const elements = elementsOf([
      { role: 'treeitem', name: '2025' },
      { role: 'treeitem', name: 'Invoices', parentIndex: 0 },
      { role: 'treeitem', name: 'Receipts', parentIndex: 0 },
    ])
    const judgement = judgeStatedTarget(
      { role: 'treeitem', name: 'Invoices', row: 'Receipts' },
      named(elements, 'Invoices'),
      elements,
    )
    expect(judgement).toMatchObject({ verdict: 'contradicts', reasons: ['row'] })
  })

  it("a control inside a nested row container reads only that container's row", () => {
    const elements = elementsOf([
      { role: 'listitem', text: 'Ann: first post' },
      { role: 'listitem', text: 'Bo: a reply', parentIndex: 0 },
      { role: 'button', name: 'Reply', parentIndex: 1 },
    ])
    expect(rowTextOf(named(elements, 'Reply'), elements)).toBe('Bo: a reply Reply')
  })

  // Only a parent of the row's own role joins its row.
  it('an article never adds its prose to a nested row', () => {
    const elements = elementsOf([
      { role: 'article', text: 'Status: 2 invoices due this week' },
      { role: 'row', name: 'Invoice 947', parentIndex: 0 },
      { role: 'button', name: 'Pay', parentIndex: 1 },
    ])
    expect(rowTextOf(named(elements, 'Invoice 947'), elements)).toBe('Invoice 947 Pay')
    expect(rowTextOf(named(elements, 'Pay'), elements)).toBe('Invoice 947 Pay')
  })

  // Every enclosing row of the same role joins, nearest first.
  it('a leaf three levels deep carries every enclosing same-role row line', () => {
    const elements = elementsOf([
      { role: 'treeitem', name: 'Invoices' },
      { role: 'treeitem', name: '2025', parentIndex: 0 },
      { role: 'treeitem', name: 'Q1', parentIndex: 1 },
    ])
    expect(rowTextOf(named(elements, 'Q1'), elements)).toBe('Q1 2025 Invoices')
    expect(rowTextOf(named(elements, '2025'), elements)).toBe('2025 Q1 Invoices')
  })

  it('wordTokens reads a well-formed lakh group as one number', () => {
    expect(wordTokens('1,00,000')).toEqual(['100000'])
    expect(wordTokens('12,34,567 1,23,45,678')).toEqual(['1234567', '12345678'])
  })
})
