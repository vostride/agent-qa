// D-16 / T-392-35: NO PRODUCTION KNOB CAN DISABLE THE DETERMINISTIC OVERRIDE.
//
// The mutation proof next door shows what switching the reconciliation strategy COSTS. This file
// shows that nothing outside a composition can do it. Both halves are needed and neither implies
// the other: a differential that measured the cost of removing a safety property would be a
// horror story rather than a proof if a configuration file could remove it too.
//
// TWO INDEPENDENT REACH SURFACES, because a knob has two ways to exist.
//
//   1. A CONFIGURATION KEY. Answered by walking the PARSED zod shapes this system publishes and
//      asking whether any key names the concept — never by grepping file text, which the rationale
//      comments in `compose-local-agent.ts` and `ports.ts` would defeat in the first line they
//      mention the word. Plan 07's composed e2e walks four hand-named config schemas; this walk is
//      DISCOVERED instead — every exported zod schema in `@vostride/agent-qa-schema`, found by
//      inspecting the package's own exports — so a config surface added later joins the walk
//      without anyone remembering to add it. That is the difference between a pin and a list.
//
//   2. AN ENVIRONMENT VARIABLE. The 391 lesson, applied here: an ambient env lever is a knob that
//      no schema mentions and every process inherits. It is answered against the BUILT dist rather
//      than the source, because the dist is what actually runs, and every occurrence is adjudicated
//      BY NAME — a zero-hit result and a list of adjudicated non-strategy hits both pass, an
//      unadjudicated strategy-shaped hit fails.
//
// EVERY WALK CARRIES A NON-VACUITY GUARD AND A POSITIVE CONTROL. Without them, "there is no knob"
// and "the detector is broken" are the same green, which is the failure this whole plan exists to
// make impossible.

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as schemaExports from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

/** The built artifacts that actually run. Resolved relative to this package, not to a cwd. */
const AGENT_DIST = fileURLToPath(new URL('../../../agent/dist/index.js', import.meta.url))
const AGENT_LOCAL_DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url))

/**
 * The zod internals both zod 3 and zod 4 expose a definition through.
 *
 * Read defensively rather than through a typed API: this walk is deliberately structural, and a
 * shape it cannot read must contribute nothing rather than throw — a walker that crashed on one
 * unfamiliar node would leave the assertion below unexercised for every node after it.
 */
interface ZodDef {
  readonly type?: string
  readonly shape?: Record<string, unknown>
  readonly options?: readonly unknown[]
  readonly innerType?: unknown
  readonly element?: unknown
  readonly valueType?: unknown
  readonly left?: unknown
  readonly right?: unknown
  readonly in?: unknown
  readonly out?: unknown
  readonly getter?: () => unknown
}

function defOf(node: unknown): ZodDef | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const internal = node as { _zod?: { def?: ZodDef }; def?: ZodDef }
  return internal._zod?.def ?? internal.def
}

/**
 * Every export-qualified key site reachable in any schema this package publishes.
 *
 * DISCOVERED from the package's own export table, so the inventory cannot fall behind the schemas.
 * A hand-written list of schemas is a list somebody has to remember to extend, and the day it is
 * not extended is the day this assertion stops covering the surface that grew.
 */
interface SchemaKeySite {
  readonly path: string
  readonly key: string
  readonly owner: unknown
}

function collectSchemaKeySites(
  exports: Readonly<Record<string, unknown>> = schemaExports,
): SchemaKeySite[] {
  const sites: SchemaKeySite[] = []

  const walk = (node: unknown, path: string, depth: number, ancestors: ReadonlySet<unknown>): void => {
    if (depth > 16 || ancestors.has(node)) return
    const def = defOf(node)
    if (def === undefined) return
    // Only cycles are skipped. A global seen-set would hide a shared receipt schema
    // reused by a new configuration export, precisely the override path this guard must catch.
    const nextAncestors = new Set(ancestors).add(node)
    const child = (value: unknown, childPath = path): void =>
      walk(value, childPath, depth + 1, nextAncestors)
    switch (def.type) {
      case 'object':
        for (const [key, value] of Object.entries(def.shape ?? {})) {
          const keyPath = `${path}.${key}`
          sites.push({ path: keyPath, key, owner: node })
          child(value, keyPath)
        }
        break
      case 'union':
        for (const option of def.options ?? []) child(option)
        break
      case 'optional':
      case 'nullable':
      case 'default':
      case 'nonoptional':
      case 'readonly':
      case 'catch':
        child(def.innerType)
        break
      case 'array':
        child(def.element, `${path}[]`)
        break
      case 'record':
        child(def.valueType, `${path}{}`)
        break
      case 'intersection':
        child(def.left)
        child(def.right)
        break
      case 'pipe':
        child(def.in)
        child(def.out)
        break
      case 'lazy':
        child(def.getter?.())
        break
      default:
        break
    }
  }

  for (const [name, exported] of Object.entries(exports)) walk(exported, name, 0, new Set())
  return sites
}

/**
 * A key that could name the reconciliation strategy or a switch over it.
 *
 * Deliberately WIDER than the seam's own spelling: `chatReconcile` is what exists today, and a knob
 * that arrived would arrive under whatever name its author chose. The three shapes are the concept
 * (`reconcil`), the switch (`override`), and the seam type (`strateg` in chat's company).
 */
function strategyKnobKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const lowered = key.toLowerCase()
    return (
      lowered.includes('reconcil')
      || lowered.includes('override')
      || (lowered.includes('chat') && lowered.includes('strateg'))
    )
  })
}

function strategyKnobSites(sites: readonly SchemaKeySite[]): SchemaKeySite[] {
  return sites.filter(site => strategyKnobKeys([site.key]).length > 0)
}

/** Every `process.env` read in a built artifact, as the variable names it reaches for. */
function envReads(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(/process\s*\.\s*env\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g)) {
    names.add(match[1] ?? match[2] ?? '?')
  }
  // A bare `process.env` handed somewhere whole is a read this pattern would otherwise miss, and it
  // is the shape a knob would hide in — so it is reported under a name that cannot be adjudicated
  // away by accident.
  const bare = source.match(/process\s*\.\s*env(?!\s*[.[])/g)
  if (bare !== null) for (const _ of bare) names.add('<whole process.env object>')
  return [...names].sort()
}

function readDist(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `${path} is not built. This assertion is about what RUNS, so it reads the dist rather than `
        + 'the source; run the workspace build before this suite.',
    )
  }
  return readFileSync(path, 'utf8')
}

describe('D-16: the reconciliation strategy is reachable from no configuration key', () => {
  it('walks a real, non-empty, DISCOVERED schema-key inventory', () => {
    const keys = [...new Set(collectSchemaKeySites().map(site => site.key))]
    // A walker that silently returned nothing would pass the assertion below forever.
    expect(keys.length).toBeGreaterThan(100)
    // And it must reach the config schemas, not only the DTOs: one key each from the browser,
    // device and platform-base schemas the hand-written walk in the compound e2e names.
    for (const key of ['headless', 'match', 'timeouts']) expect(keys).toContain(key)
  })

  it('no published schema exposes a strategy switch', () => {
    expect(strategyKnobSites(collectSchemaKeySites())).toEqual([])
  })

  it('POSITIVE CONTROL: the detector flags such a key when one exists', () => {
    expect(strategyKnobKeys(['timeouts', 'chatReconcile'])).toEqual(['chatReconcile'])
    expect(strategyKnobKeys(['disableOverride'])).toEqual(['disableOverride'])
    expect(strategyKnobKeys(['chatStrategy'])).toEqual(['chatStrategy'])
    expect(strategyKnobKeys(['reconciliationMode'])).toEqual(['reconciliationMode'])
    expect(strategyKnobKeys(['overrideConfigured'])).toEqual(['overrideConfigured'])
  })
})

describe('D-16: and from no environment variable either', () => {
  it('reads a real, freshly built artifact rather than a missing one', () => {
    const agent = readDist(AGENT_DIST)
    // The non-vacuity guard: a dist that did not contain the chat subtree would report zero env
    // reads while proving nothing about chat. These two markers exist only because chat does.
    expect(agent).toContain('mark_unhandled')
    expect(agent).toContain('deterministicOverrideStrategy')
    expect(readDist(AGENT_LOCAL_DIST)).toContain('chatReconcile')
  })

  it('the built agent artifact reads NO environment variable — adjudicated by name', () => {
    // Every hit is listed rather than counted, because the claim this assertion makes is not
    // "there are few" but "each one is not a strategy lever". A zero-hit result is the strongest
    // form of that and is what this package reports today; if a legitimate read ever arrives, it
    // gets named here and the adjudication is visible in the diff that added it.
    expect(envReads(readDist(AGENT_DIST))).toEqual([])
  })

  it('the built composition artifact reads NO environment variable either', () => {
    // `agent-local` is where the strategy option is CONSUMED, so it is the second place an ambient
    // lever could live — a composition that read one would make the seam config-reachable without
    // any schema ever naming it (the 391 lesson).
    expect(envReads(readDist(AGENT_LOCAL_DIST))).toEqual([])
  })

  it('POSITIVE CONTROL: the env detector finds reads in all three shapes', () => {
    expect(envReads('const a = process.env.AGENT_QA_DISABLE_OVERRIDE')).toEqual([
      'AGENT_QA_DISABLE_OVERRIDE',
    ])
    expect(envReads("const b = process.env['CHAT_STRATEGY']")).toEqual(['CHAT_STRATEGY'])
    expect(envReads('const c = { ...process.env }')).toEqual(['<whole process.env object>'])
  })
})

describe('the seam exists, and exists only as a composition option', () => {
  it('is named in the composition input', () => {
    // The other direction of the same claim, and it is what stops the two assertions above from
    // being satisfied by the seam having quietly disappeared: `chatReconcile` IS reachable — by a
    // caller holding the code that composes a host, which is the only reach D-16 permits.
    const composition = readFileSync(
      fileURLToPath(new URL('../composition/compose-local-agent.ts', import.meta.url)),
      'utf8',
    )
    expect(composition).toContain('readonly chatReconcile?: ReconcileStrategy')
    // And a project configuration cannot name it. The config `agent-qa init` writes is checked
    // in the CLI's init-config-schema.test.ts; this package does not depend on the CLI.
  })
})
