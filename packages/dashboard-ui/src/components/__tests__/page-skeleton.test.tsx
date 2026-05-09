// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ChartSkeleton,
  DetailSkeleton,
  EditorSkeleton,
  FormSkeleton,
  TableSkeleton,
} from '@/components/page-skeleton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(element: ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  act(() => {
    root!.render(element)
  })

  return container
}

function expectClassTokens(element: Element | null | undefined, tokens: string[]) {
  expect(element).not.toBeNull()
  const classes = new Set(String(element?.className ?? '').split(/\s+/).filter(Boolean))
  for (const token of tokens) {
    expect(classes.has(token)).toBe(true)
  }
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  container?.remove()
  container = null
})

describe('shared page skeleton shape contracts', () => {
  it('TableSkeleton keeps list rows rectangular and muted', () => {
    const view = render(<TableSkeleton rows={3} />)

    const shell = view.querySelector('[data-skeleton="table"]')
    expectClassTokens(shell, ['space-y-4'])
    expect(shell?.querySelectorAll('[data-skeleton-part="table-row"]').length).toBe(3)
    for (const row of shell?.querySelectorAll('[data-skeleton-part="table-row"]') ?? []) {
      expectClassTokens(row, ['h-14', 'w-full', 'rounded-none', 'bg-muted'])
    }
  })

  it('ChartSkeleton renders the Insights line-grid loading geometry', () => {
    const view = render(<ChartSkeleton />)

    const shell = view.querySelector('[data-skeleton="insights"]')
    expectClassTokens(shell, ['h-full', 'min-h-0', 'overflow-y-auto', 'p-4', 'md:p-6'])
    expect(shell?.querySelector('[data-skeleton-part="insights-heading-row"]')).not.toBeNull()
    expectClassTokens(shell?.querySelector('[data-skeleton-part="insights-kpi-grid"]'), [
      'rounded-none',
      'border',
      'border-border',
      'bg-transparent',
    ])
    expect(shell?.querySelectorAll('[data-skeleton-part="insights-kpi-cell"]').length).toBeGreaterThanOrEqual(4)
    expect(shell?.querySelectorAll('[data-skeleton-part="insights-chart-cell"]').length).toBeGreaterThanOrEqual(2)
    for (const chart of shell?.querySelectorAll('[data-skeleton-part="insights-chart-cell"]') ?? []) {
      expectClassTokens(chart, ['h-[220px]', 'rounded-none', 'border-border'])
    }
    expect(shell?.querySelectorAll('[data-skeleton-part="insights-secondary-cell"]').length).toBeGreaterThanOrEqual(2)
    expectClassTokens(shell?.querySelector('[data-skeleton-part="insights-breakdown-block"]'), [
      'rounded-none',
      'border-border',
      'min-h-[420px]',
    ])
  })

  it('FormSkeleton renders the Config rail and main-section geometry', () => {
    const view = render(<FormSkeleton />)

    const shell = view.querySelector('[data-skeleton="config"]')
    expectClassTokens(shell, ['h-full', 'min-h-0', 'p-4', 'md:p-6'])
    expect(shell?.querySelector('[data-skeleton-part="config-title-row"]')).not.toBeNull()
    expectClassTokens(shell?.querySelector('[data-skeleton-part="config-layout"]'), [
      'grid',
      'gap-0',
      'lg:grid-cols-[minmax(240px,256px)_minmax(0,1fr)]',
      'rounded-none',
      'border',
      'border-border',
      'bg-transparent',
    ])
    expectClassTokens(shell?.querySelector('[data-skeleton-part="config-rail"]'), [
      'border-r',
      'border-border',
      'rounded-none',
    ])
    expectClassTokens(shell?.querySelector('[data-skeleton-part="config-main"]'), [
      'rounded-none',
      'border-border',
      'h-[32rem]',
    ])
  })

  it('DetailSkeleton reserves a stable run and live detail layout', () => {
    const view = render(<DetailSkeleton />)

    const shell = view.querySelector('[data-skeleton="detail"]')
    expectClassTokens(shell, ['h-full', 'min-h-0', 'p-4', 'md:p-6'])
    expect(shell?.querySelector('[data-skeleton-part="detail-header-nav"]')).not.toBeNull()
    expectClassTokens(shell?.querySelector('[data-skeleton-part="detail-timeline-column"]'), [
      'rounded-none',
      'border-border',
      'min-h-[420px]',
    ])
    expectClassTokens(shell?.querySelector('[data-skeleton-part="detail-screenshot-region"]'), [
      'rounded-none',
      'border-border',
      'h-[32rem]',
    ])
  })

  it('EditorSkeleton reserves the workstation editor surface without rounded blocks', () => {
    const view = render(<EditorSkeleton />)

    const shell = view.querySelector('[data-skeleton="editor"]')
    expectClassTokens(shell, ['h-full', 'min-h-0', 'p-4', 'md:p-6'])
    expect(shell?.querySelector('[data-skeleton-part="editor-toolbar"]')).not.toBeNull()
    expectClassTokens(shell?.querySelector('[data-skeleton-part="editor-surface"]'), [
      'rounded-none',
      'border-border',
      'h-[500px]',
    ])
  })
})
