import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

type SourceKey =
  | 'runs'
  | 'tests'
  | 'hooks'
  | 'suites'
  | 'memory'
  | 'config'
  | 'testViewer'
  | 'liveRun'
  | 'runDetail'
  | 'styles'
  | 'appSidebar'
  | 'commandPalette'
  | 'productTourSteps'

const sources: Record<SourceKey, string> = {
  runs: readSource('../../components/runs-table.tsx'),
  tests: readSource('../../pages/tests.tsx'),
  hooks: readSource('../../pages/hooks.tsx'),
  suites: readSource('../../pages/suites.tsx'),
  memory: readSource('../../pages/memory.tsx'),
  config: readSource('../../pages/config.tsx'),
  testViewer: readSource('../../pages/test-viewer.tsx'),
  liveRun: readSource('../../pages/live-run.tsx'),
  runDetail: readSource('../../pages/run-detail.tsx'),
  styles: readSource('../../styles/globals.css'),
  appSidebar: readSource('../../components/app-sidebar.tsx'),
  commandPalette: readSource('../../components/command-palette.tsx'),
  productTourSteps: readSource('../product-tour-steps.ts'),
}

const routeSources = [
  sources.runs,
  sources.tests,
  sources.hooks,
  sources.suites,
  sources.memory,
  sources.config,
].join('\n')

const approvedUiSpecAnchorIds = [
  'tour-nav-runs',
  'tour-nav-tests',
  'tour-nav-hooks',
  'tour-nav-suites',
  'tour-nav-memory',
  'tour-nav-config',
  'tour-help-menu',
  'tour-help-product-tour',
  'tour-command-product-tour',
  'tour-runs-table',
  'tour-tests-table',
  'tour-tests-new',
  'tour-hooks-table',
  'tour-hooks-new',
  'tour-suites-table',
  'tour-suites-new',
  'tour-memory-table',
  'tour-config-nav',
  'tour-config-section',
  'tour-test-detail-overview',
  'tour-test-run-action',
  'tour-live-run-status',
  'tour-run-detail-reasoning',
] as const

const approvedAnchors = [
  {
    file: 'runs',
    anchor: 'tour-runs-table',
    element: 'ScrollArea',
  },
  {
    file: 'tests',
    anchor: 'tour-tests-table',
    element: 'ScrollArea',
  },
  {
    file: 'tests',
    anchor: 'tour-tests-new',
    element: 'Button',
  },
  {
    file: 'hooks',
    anchor: 'tour-hooks-table',
    element: 'ScrollArea',
  },
  {
    file: 'hooks',
    anchor: 'tour-hooks-new',
    element: 'Button',
  },
  {
    file: 'suites',
    anchor: 'tour-suites-table',
    element: 'ScrollArea',
  },
  {
    file: 'suites',
    anchor: 'tour-suites-new',
    element: 'Button',
  },
  {
    file: 'memory',
    anchor: 'tour-memory-table',
    element: 'ScrollArea',
  },
] as const satisfies readonly {
  file: SourceKey
  anchor: string
  element: string
}[]

const detailFlowAnchors = [
  {
    file: 'testViewer',
    anchor: 'tour-test-detail-overview',
    element: 'TabsContent',
    prop: 'data-tour-id',
  },
  {
    file: 'testViewer',
    anchor: 'tour-test-run-action',
    element: 'TestNavbar',
    prop: 'runButtonTourId',
  },
  {
    file: 'liveRun',
    anchor: 'tour-live-run-status',
    element: 'div',
    prop: 'data-tour-id',
  },
  {
    file: 'runDetail',
    anchor: 'tour-run-detail-reasoning',
    element: 'ResizablePanel',
    prop: 'data-tour-id',
  },
] as const satisfies readonly {
  file: SourceKey
  anchor: string
  element: string
  prop: string
}[]

const emptyStateAnchors = [
  {
    file: 'tests',
    anchor: 'tour-tests-table',
  },
  {
    file: 'hooks',
    anchor: 'tour-hooks-table',
  },
  {
    file: 'suites',
    anchor: 'tour-suites-table',
  },
  {
    file: 'memory',
    anchor: 'tour-memory-table',
  },
] as const satisfies readonly {
  file: SourceKey
  anchor: string
}[]

const forbiddenDynamicPatterns = [
  'data-runs-row-surface',
  'data-memory-product',
  'row.id',
  'run.id',
  'child.id',
  'product.productKey',
  'suite.suiteId',
  'hook.id',
  'test.testId',
  'index',
  'idx',
]

describe('product tour route anchors', () => {
  it('places table and create-action anchors on approved stable elements', () => {
    for (const expected of approvedAnchors) {
      const count = countOccurrences(routeSources, expected.anchor)
      if (isEmptyStateTableAnchor(expected)) {
        expect(count, expected.anchor).toBeGreaterThanOrEqual(2)
      } else {
        expect(count, expected.anchor).toBe(1)
      }
      expectAnchorOnElement(sources[expected.file], expected.anchor, expected.element)
    }
  })

  it('keeps page overview anchors available on empty states', () => {
    for (const expected of emptyStateAnchors) {
      expectAnchorBeforeComponent(sources[expected.file], expected.anchor, 'EmptyState')
    }
  })

  it('places first-run detail flow anchors on approved stable surfaces', () => {
    for (const expected of detailFlowAnchors) {
      const source = sources[expected.file]

      expect(countOccurrences(source, expected.anchor), expected.anchor).toBe(1)
      expectPropOnElement(source, expected.anchor, expected.element, expected.prop)
    }
  })

  it('contains every approved UI-SPEC anchor and rejects unapproved tour IDs', () => {
    const combinedSource = Object.values(sources).join('\n')
    const declaredTourIds = extractDeclaredTourIds(combinedSource)

    for (const anchor of approvedUiSpecAnchorIds) {
      expect(combinedSource, anchor).toContain(anchor)
      expect(declaredTourIds, anchor).toContain(anchor)
    }

    for (const declaredTourId of declaredTourIds) {
      expect(approvedUiSpecAnchorIds, declaredTourId).toContain(declaredTourId)
    }
  })

  it('does not attach tour anchors to dynamic row or identifier surfaces', () => {
    for (const [file, source] of Object.entries(sources)) {
      const tourAnchorBlocks = getTourAnchorBlocks(source)

      for (const block of tourAnchorBlocks) {
        for (const forbidden of forbiddenDynamicPatterns) {
          expect(block, `${file} data-tour-id block must not contain ${forbidden}`).not.toContain(
            forbidden,
          )
        }
      }
    }
  })

  it('places Config anchors on navigation and active section surfaces', () => {
    const configSource = sources.config

    expect(configSource).toContain('data-config-rail')
    expect(configSource).toContain('data-config-mobile-selector')
    expect(configSource).toContain('data-config-main')
    expect(configSource).toContain('tour-config-nav')
    expect(configSource).toContain('tour-config-section')
    expect(hasConfigNavAnchor(configSource)).toBe(true)
    expectAnchorOnElement(configSource, 'tour-config-section', 'section')
  })

  it('keeps the product tour highlight pulse reduced-motion safe', () => {
    const styles = sources.styles

    expect(styles).toContain('@keyframes product-tour-highlight-pulse')
    expect(styles).toContain(
      '--animate-product-tour-highlight-pulse: product-tour-highlight-pulse 3.2s ease-in-out infinite;',
    )
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.animate-product-tour-highlight-pulse[\s\S]*animation: none/,
    )
  })
})

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf-8')
}

function countOccurrences(source: string, needle: string) {
  return source.split(needle).length - 1
}

function extractDeclaredTourIds(source: string) {
  const patterns = [
    /data-tour-id=["'](tour-[a-z0-9-]+)["']/g,
    /\btourId:\s*["'](tour-[a-z0-9-]+)["']/g,
    /\brunButtonTourId=["'](tour-[a-z0-9-]+)["']/g,
    /\btargetId:\s*["'](tour-[a-z0-9-]+)["']/g,
  ]
  const declared = patterns.flatMap((pattern) =>
    Array.from(source.matchAll(pattern), (match) => match[1]!),
  )

  return Array.from(new Set(declared)).sort()
}

function expectAnchorOnElement(source: string, anchor: string, element: string) {
  expectPropOnElement(source, anchor, element, 'data-tour-id')
}

function expectPropOnElement(source: string, anchor: string, element: string, prop: string) {
  expect(source, anchor).toMatch(
    new RegExp(`<${element}\\b[\\s\\S]*?${prop}="${anchor}"[\\s\\S]*?>`),
  )
}

function expectAnchorBeforeComponent(source: string, anchor: string, component: string) {
  expect(source, anchor).toMatch(new RegExp(`data-tour-id="${anchor}"[\\s\\S]*<${component}\\b`))
}

function isEmptyStateTableAnchor(expected: (typeof approvedAnchors)[number]) {
  return emptyStateAnchors.some(
    (emptyAnchor) => emptyAnchor.file === expected.file && emptyAnchor.anchor === expected.anchor,
  )
}

function hasConfigNavAnchor(source: string) {
  const hasDesktopRailAnchor = hasAttributePair(source, 'aside', 'data-config-rail', 'tour-config-nav')
  const hasMobileSelectorAnchor = hasAttributePair(
    source,
    'section',
    'data-config-mobile-selector',
    'tour-config-nav',
  )
  const hasSharedWrapperAnchor = /data-tour-id="tour-config-nav"[\s\S]*data-config-rail[\s\S]*data-config-mobile-selector/.test(
    source,
  )

  return (hasDesktopRailAnchor && hasMobileSelectorAnchor) || hasSharedWrapperAnchor
}

function hasAttributePair(source: string, element: string, dataAttribute: string, tourAnchor: string) {
  const openingTagPattern = new RegExp(`<${element}\\b[\\s\\S]*?>`, 'g')
  const openingTags = source.match(openingTagPattern) ?? []

  return openingTags.some(
    (tag) => tag.includes(dataAttribute) && tag.includes(`data-tour-id="${tourAnchor}"`),
  )
}

function getTourAnchorBlocks(source: string) {
  const lines = source.split('\n')

  return lines.flatMap((line, index) => {
    if (!line.includes('data-tour-id')) return []

    const start = Math.max(0, index - 3)
    const end = Math.min(lines.length, index + 4)
    return [lines.slice(start, end).join('\n')]
  })
}
