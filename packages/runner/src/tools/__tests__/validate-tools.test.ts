import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Surface } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../registry.js'
import { registerAllActions } from '../actions/index.js'
import { VERB_SURFACE } from '../actions/surface-map.js'
import type { ToolDefinition } from '../types.js'

const legalSurfaces = new Set<Surface>(['web', 'mobile', 'android', 'ios', 'common'])
const platforms = ['web', 'android', 'ios'] as const

const registry = new ToolRegistry()
registerAllActions(registry)
const defs = registry.getAll()
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

interface SourceFile {
  path: string
  source: string
}

const actionSourceFiles: SourceFile[] = globSync('src/tools/actions/**/*.ts', { cwd: pkgRoot })
  .filter(file => !file.includes('__tests__'))
  .map(file => ({
    path: file,
    source: readFileSync(join(pkgRoot, file), 'utf8'),
  }))

function fixtureTool(overrides: Record<string, unknown> = {}): ToolDefinition {
  return {
    id: 'mobile_tap',
    type: 'tap',
    surface: 'mobile',
    description: 'fixture tool',
    category: 'action',
    schema: z.object({}).strict(),
    ...overrides,
  } as ToolDefinition
}

function findSurfaceIdOffenders(toolDefs: readonly ToolDefinition[]): string[] {
  const offenders: string[] = []

  for (const def of toolDefs) {
    const surface = def.surface as string
    if (!surface || !legalSurfaces.has(surface as Surface)) {
      offenders.push(`${def.id}: invalid surface "${surface}"`)
      continue
    }

    const expectedId = `${surface}_${def.type}`
    if (def.id !== expectedId) {
      offenders.push(`${def.id}: expected id "${expectedId}" for ${surface}/${def.type}`)
    }
  }

  return offenders
}

function findVerbSurfaceBijectionOffenders(
  toolDefs: readonly ToolDefinition[],
  verbSurface: Record<string, string>,
): string[] {
  const offenders: string[] = []
  const registeredTypes = new Set(toolDefs.map(def => def.type))
  const mappedTypes = new Set(Object.keys(verbSurface))

  for (const type of registeredTypes) {
    if (!mappedTypes.has(type)) {
      offenders.push(`${type}: registered type missing from VERB_SURFACE`)
    }
  }

  for (const type of mappedTypes) {
    if (!registeredTypes.has(type)) {
      offenders.push(`${type}: VERB_SURFACE key missing from registry`)
    }
  }

  for (const [type, surface] of Object.entries(verbSurface)) {
    if (!legalSurfaces.has(surface as Surface)) {
      offenders.push(`${type}: illegal surface "${surface}"`)
    }
  }

  return offenders
}

const allowedToolKeys = new Set([
  'id',
  'type',
  'surface',
  'description',
  'category',
  'schema',
  'destructive',
  'readOnly',
])

function findForbiddenKeyOffenders(toolDefs: readonly ToolDefinition[]): string[] {
  const offenders: string[] = []

  for (const def of toolDefs) {
    for (const key of Object.keys(def)) {
      if (!allowedToolKeys.has(key)) {
        offenders.push(`${def.id}: forbidden ToolDefinition key "${key}"`)
      }
    }
  }

  return offenders
}

function findHiddenPlannerToolOffenders(
  toolDefs: readonly ToolDefinition[],
  platformToolDefs: readonly (readonly ToolDefinition[])[],
): string[] {
  const toolIds = new Set(toolDefs.map(def => def.id))
  const platformIds = new Set(
    platformToolDefs
      .flat()
      .map(def => def.id),
  )
  const offenders: string[] = []

  for (const id of toolIds) {
    if (!platformIds.has(id)) {
      offenders.push(`${id}: tool missing from every platform slice`)
    }
  }

  for (const id of platformIds) {
    if (!toolIds.has(id)) {
      offenders.push(`${id}: platform slice exposes an unregistered tool`)
    }
  }

  return offenders
}

function findLooseZodOffenders(sourceFiles: readonly SourceFile[]): string[] {
  const offenders: string[] = []
  const looseZodPattern = /\bz\.(?:any|unknown)\s*\(/

  for (const file of sourceFiles) {
    const lines = file.source.split('\n')

    lines.forEach((line, index) => {
      if (!looseZodPattern.test(line)) return

      const previousLine = lines[index - 1] ?? ''
      if (line.includes('// escape-hatch:') || previousLine.trim().startsWith('// escape-hatch:')) {
        return
      }

      offenders.push(`${file.path}:${index + 1}: z.any()/z.unknown() requires // escape-hatch:`)
    })
  }

  return offenders
}

function collectFieldDeclaration(lines: readonly string[], startIndex: number): string {
  const parts = [lines[startIndex]]

  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 8); index += 1) {
    const line = lines[index]
    if (/^\s+[A-Za-z_$][\w$]*\s*:/.test(line)) break

    parts.push(line)
    if (line.includes('.describe(')) break
  }

  return parts.join('\n')
}

function findOptionalDescribeOffenders(sourceFiles: readonly SourceFile[]): string[] {
  const offenders: string[] = []

  for (const file of sourceFiles) {
    const lines = file.source.split('\n')

    lines.forEach((line, index) => {
      const fieldMatch = /^(\s+)([A-Za-z_$][\w$]*)\s*:/.exec(line)
      if (!fieldMatch) return
      if (!line.includes('.optional()') && !line.includes('.default(')) return

      const declaration = collectFieldDeclaration(lines, index)
      if (declaration.includes('z.never(')) return
      if (/omit/i.test(declaration)) return

      offenders.push(`${file.path}:${index + 1}: ${fieldMatch[2]} optional/default field must describe when to omit it`)
    })
  }

  return offenders
}

function findBareRefSchemaOffenders(sourceFiles: readonly SourceFile[]): string[] {
  const offenders: string[] = []
  const bareRefPattern = /^\s*(ref|fromRef|toRef)\s*:\s*z\.string\s*\(/

  for (const file of sourceFiles) {
    const lines = file.source.split('\n')

    lines.forEach((line, index) => {
      const match = bareRefPattern.exec(line)
      if (match) {
        offenders.push(`${file.path}:${index + 1}: ${match[1]} must use refSchema(`)
      }
    })
  }

  return offenders
}

describe('LINT-02', () => {
  it('requires every tool id to match its declared surface and type', () => {
    expect(findSurfaceIdOffenders(defs)).toEqual([])
  })

  it('rejects held-out surface/id mismatches and accepts clean ids', () => {
    expect(findSurfaceIdOffenders([
      fixtureTool({ id: 'web_click', surface: 'mobile', type: 'click' }),
    ])).toEqual([
      'web_click: expected id "mobile_click" for mobile/click',
    ])

    expect(findSurfaceIdOffenders([
      fixtureTool({ id: 'mobile_tap', surface: 'mobile', type: 'tap' }),
    ])).toEqual([])
  })
})

describe('LINT-03', () => {
  it('keeps registered tool types in bijection with VERB_SURFACE keys', () => {
    expect(findVerbSurfaceBijectionOffenders(defs, VERB_SURFACE)).toEqual([])
  })

  it('rejects held-out missing verbs and illegal surface tiers while accepting clean maps', () => {
    const cleanDefs = [fixtureTool({ id: 'mobile_tap', type: 'tap', surface: 'mobile' })]

    expect(findVerbSurfaceBijectionOffenders(cleanDefs, { tap: 'mobile' })).toEqual([])
    expect(findVerbSurfaceBijectionOffenders(cleanDefs, {})).toEqual([
      'tap: registered type missing from VERB_SURFACE',
    ])
    expect(findVerbSurfaceBijectionOffenders(cleanDefs, { tap: 'desktop' })).toEqual([
      'tap: illegal surface "desktop"',
    ])
  })
})

describe('tool definition metadata', () => {
  it('keeps ToolDefinition metadata on the allowed key set', () => {
    expect(findForbiddenKeyOffenders(defs)).toEqual([])
  })

  it('keeps every tool present in a platform slice', () => {
    expect(findHiddenPlannerToolOffenders(
      defs,
      platforms.map(platform => registry.getForPlatform(platform)),
    )).toEqual([])
  })

  it('rejects held-out hidden planner metadata and accepts clean tools', () => {
    const cleanDef = fixtureTool({ id: 'mobile_tap', type: 'tap', surface: 'mobile' })

    expect(findForbiddenKeyOffenders([cleanDef])).toEqual([])
    expect(findForbiddenKeyOffenders([
      fixtureTool({ id: 'mobile_tap', type: 'tap', surface: 'mobile', tier: 'fast' }),
    ])).toEqual([
      'mobile_tap: forbidden ToolDefinition key "tier"',
    ])

    expect(findHiddenPlannerToolOffenders([cleanDef], [[cleanDef]])).toEqual([])
    expect(findHiddenPlannerToolOffenders([cleanDef], [[]])).toEqual([
      'mobile_tap: tool missing from every platform slice',
    ])
  })
})

describe('LINT-04', () => {
  it('requires z.any() and z.unknown() to carry an escape-hatch marker', () => {
    expect(findLooseZodOffenders(actionSourceFiles)).toEqual([])
  })

  it('rejects held-out loose Zod usage and accepts documented escape hatches', () => {
    expect(findLooseZodOffenders([
      { path: 'fixture.ts', source: 'const raw = z.any()' },
    ])).toEqual([
      'fixture.ts:1: z.any()/z.unknown() requires // escape-hatch:',
    ])

    expect(findLooseZodOffenders([
      { path: 'fixture.ts', source: 'const raw = z.any() // escape-hatch: raw bridge' },
      { path: 'fixture.ts', source: '// escape-hatch: raw bridge\nconst raw = z.unknown()' },
    ])).toEqual([])
  })
})

describe('LINT-05', () => {
  it('requires in-scope optional/default action params to explain when to omit them', () => {
    expect(findOptionalDescribeOffenders(actionSourceFiles)).toEqual([])
  })

  it('rejects held-out optionals without omit guidance and accepts clean guidance', () => {
    expect(findOptionalDescribeOffenders([
      {
        path: 'fixture.ts',
        source: [
          'export const fixtureSchema = z.object({',
          "  timeoutMs: z.number().optional().describe('Timeout in milliseconds'),",
          '}).strict()',
        ].join('\n'),
      },
    ])).toEqual([
      'fixture.ts:2: timeoutMs optional/default field must describe when to omit it',
    ])

    expect(findOptionalDescribeOffenders([
      {
        path: 'fixture.ts',
        source: [
          'export const fixtureSchema = z.object({',
          "  timeoutMs: z.number().optional().describe('Timeout in milliseconds. Omit when the default is acceptable.'),",
          '}).strict()',
        ].join('\n'),
      },
    ])).toEqual([])
  })

  it('rejects held-out six-space nested optionals without omit guidance and accepts clean guidance', () => {
    expect(findOptionalDescribeOffenders([
      {
        path: 'fixture.ts',
        source: [
          'export const fixtureSchema = z.object({',
          '  cookies: z.array(z.object({',
          "      domain: z.string().optional().describe('Cookie domain'),",
          '  })).describe(\'Cookies\'),',
          '}).strict()',
        ].join('\n'),
      },
    ])).toEqual([
      'fixture.ts:3: domain optional/default field must describe when to omit it',
    ])

    expect(findOptionalDescribeOffenders([
      {
        path: 'fixture.ts',
        source: [
          'export const fixtureSchema = z.object({',
          '  cookies: z.array(z.object({',
          "      domain: z.string().optional().describe('Cookie domain. Omit to use the current page host.'),",
          '  })).describe(\'Cookies\'),',
          '}).strict()',
        ].join('\n'),
      },
    ])).toEqual([])
  })
})

describe('LINT-06', () => {
  it('requires ref/fromRef/toRef fields to use refSchema', () => {
    expect(findBareRefSchemaOffenders(actionSourceFiles)).toEqual([])
  })

  it('rejects held-out bare ref strings and accepts refSchema handles', () => {
    expect(findBareRefSchemaOffenders([
      { path: 'fixture.ts', source: "const schema = z.object({\n  ref: z.string().describe('raw')\n})" },
    ])).toEqual([
      'fixture.ts:2: ref must use refSchema(',
    ])

    expect(findBareRefSchemaOffenders([
      { path: 'fixture.ts', source: "const schema = z.object({\n  ref: refSchema('target')\n})" },
    ])).toEqual([])
  })
})
