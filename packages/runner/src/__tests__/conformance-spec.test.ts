import { describe, expect, it } from 'vitest'
import { screenConformanceCases, type ConformanceInput } from '../testing/conformance.js'
import { makeInterimNodes, type InterimFixtureKind } from '../testing/screen-fixtures.js'

// The shared conformance spec passes against the reference builder; adapters run the same cases.

const KINDS: InterimFixtureKind[] = ['login-screen', 'mixed-geometry', 'nested']

describe('screen conformance spec — reference builder', () => {
  for (const kind of KINDS) {
    describe(`fixture: ${kind}`, () => {
      const make = (): ConformanceInput => {
        const { nodes, buildInput } = makeInterimNodes(kind)
        return { platform: 'web', nodes, buildInput }
      }

      for (const conformanceCase of screenConformanceCases) {
        it(conformanceCase.name, () => {
          expect(() => conformanceCase.run(make)).not.toThrow()
        })
      }
    })
  }
})

describe('screen conformance spec — cases actually assert (negative)', () => {
  it('determinism case throws when the input generator is non-deterministic', () => {
    let counter = 0
    const nonDeterministic = (): ConformanceInput => {
      const { nodes, buildInput } = makeInterimNodes('login-screen')
      counter += 1
      // Rename the leading node each call so successive builds differ — this is exactly
      // the adapter non-determinism the case exists to catch.
      const mutated = nodes.map((node, i) =>
        i === 0 ? { ...node, name: `Sign in ${counter}` } : node,
      )
      return { platform: 'web', nodes: mutated, buildInput }
    }

    const determinismCase = screenConformanceCases.find(c => c.name.startsWith('determinism'))
    expect(determinismCase).toBeDefined()
    expect(() => determinismCase!.run(nonDeterministic)).toThrow(/determinism/)
  })
})
