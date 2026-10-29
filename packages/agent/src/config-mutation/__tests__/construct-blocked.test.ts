// The BLOCKED posture, end to end through the real pipeline (Phase 395-04, CFGM-01 · D-09/D-10).
//
// 2026-09-30, 432-11 D-05: a blocked change is ANSWERED and nothing is kept. The cells below read
// the answer itself, and assert that nothing reached the store or the direct writer.
//
// 2026-10-14, 441 D-15/D-23: a config change is not scanned for secrets. The one blocked road left
// is a change whose resulting configuration does not validate; a credential-shaped value is the
// author's own text and is written (C441-CONFIG-SCAN below). The cells whose subject was the scan
// are deleted.
//
// THE DIFF PRIMITIVE IS THE PRODUCTION ONE. `renderConfigDiff` is imported from `packages/schema`;
// the doubles are the host facts this layer may not touch — bytes on disk, the yaml edit, and the
// writer.

import { utf8Decode, utf8Encode } from '@vostride/agent-qa-schema'
import type { ConfigChangeOutput } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { configFieldSetSpec } from '../../functions/ops/config-field-set.js'
import type { FunctionDeps } from '../../functions/spec.js'
import * as construct from '../construct.js'
import {
  changeConfigField,
  configFieldSetSummaryLine,
  setConfigAuth,
} from '../construct.js'
import type { ConstructConfigChangeDeps } from '../construct.js'
import type { ConfigFieldValue } from '../ports.js'

const CONFIG_FILE = 'agent-qa.config.yaml'
const HOOKS_FILE = 'hooks.yaml'

const CLEAN_CONFIG = `# agent-qa Configuration
workspace:
  hooksFile: hooks.yaml
  envFile: .env
registry:
  targets:
    shop:
      url: https://shop.example.com/cart
use:
  timeout:
    step: 30s
    test: 90m
  parallel: false
`

/** A credential-shaped probe: the author's own text, which a config change writes as given. */
const PROBE = 'sk-PROBE-1234567890'

const BUILD_TAG_CONFIG = `${CLEAN_CONFIG}  buildTag: v1.0.0\n`

/** A bearer-shaped string a person already committed, three lines above the field edited below. */
const COMMITTED_BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcm9iZSJ9.c2lnbmF0dXJlLXByb2Jl'

const CONFIG_WITH_COMMITTED_BEARER = `# agent-qa Configuration
workspace:
  hooksFile: hooks.yaml
registry:
  farmAuthorization: ${COMMITTED_BEARER}
use:
  timeout:
    step: 30s
    test: 90m
`

interface Harness {
  readonly deps: ConstructConfigChangeDeps
  /** Every proposal the pipeline tried to file. 432-11: it never files one. */
  readonly filed: unknown[]
  /** Every call the direct writer received. */
  readonly written: unknown[]
}

/**
 * The three host doubles.
 *
 * `setField` is a line-level fake: it finds the last path segment as a key and replaces its value,
 * answering the previous scalar beside the new bytes exactly as the shipped yaml port does. It is a
 * double because `yaml` is not a runtime dependency of this package by ownership contract — the
 * production edit is measured against a real file in `cli`'s composed suite.
 */
function harness(options: {
  readonly config: string
  readonly validation?:
    | { ok: false; issues: readonly { path: string; message: string }[] }
    | { ok: true }
}): Harness {
  const filed: unknown[] = []
  const written: unknown[] = []

  return {
    filed,
    written,
    deps: {
      configFiles: {
        read: () => Promise.resolve({
          configFile: CONFIG_FILE,
          hooksFile: HOOKS_FILE,
          files: [
            { path: CONFIG_FILE, bytes: utf8Encode(options.config) },
            { path: HOOKS_FILE },
            { path: '.gitignore' },
          ],
        }),
        // `config.field.set` never inspects the document, and `config.auth.set` refuses a
        // non-reference before it does, so this double THROWS rather than answering.
        inspect: () => {
          throw new Error('this construction must not inspect the document')
        },
        mintHookId: () => {
          throw new Error('config.field.set must not mint a hook id')
        },
        setField: ({ bytes, path, value }) => {
          const text = bytes === undefined ? '' : utf8Decode(bytes)
          const key = path.split('.').at(-1) ?? path
          const lines = text.split('\n')
          const index = lines.findIndex((line) => new RegExp(`^\\s*${key}:`).test(line))
          if (index === -1) {
            return Promise.resolve({ bytes: utf8Encode(`${text}${key}: ${String(value)}\n`) })
          }
          const line = lines[index] ?? ''
          const previous = line.slice(line.indexOf(':') + 1).trim()
          lines[index] = `${line.slice(0, line.indexOf(':'))}: ${String(value)}`
          return Promise.resolve({
            bytes: utf8Encode(lines.join('\n')),
            ...(previous === '' ? {} : { previousValue: previous as ConfigFieldValue }),
          })
        },
      },
      configValidate: {
        validate: () => Promise.resolve(options.validation ?? { ok: true }),
      },
      configWrite: {
        applyFields: (request) => {
          written.push(request)
          return Promise.resolve({
            kind: 'applied' as const,
            file: CONFIG_FILE,
            revision: 'revision-after',
            baseRevision: 'revision-before',
          })
        },
        publishFiles: (request) => {
          written.push(request)
          return Promise.resolve({ kind: 'published' as const, written: [CONFIG_FILE] })
        },
      },
    },
  }
}

async function propose(
  test: Harness,
  input: { path: string; value: ConfigFieldValue },
): Promise<ConfigChangeOutput> {
  return await changeConfigField(
    { action: 'config.field.set', path: input.path, value: input.value },
    test.deps,
  )
}

describe('the blocked posture', () => {
  it('(1) answers BLOCKED when the whole config no longer validates, and keeps nothing', async () => {
    const test = harness({
      config: CLEAN_CONFIG,
      validation: {
        ok: false,
        issues: [{ path: CONFIG_FILE, message: 'use.parallel: expected boolean, received string' }],
      },
    })

    const answer = await propose(test, { path: 'parallel', value: 'yes please' })

    expect(answer.outcome).toBe('blocked')
    if (answer.outcome !== 'blocked') throw new Error('unreachable')
    expect(answer.blockedReason).toBe('schema-fail')
    // 395-10: the answered string is the port's PAIR joined — the file the issue is about, then
    // the validator's own sentence — so the file is not guessed at from what the change diffed.
    expect(answer.validationIssues)
      .toEqual([`${CONFIG_FILE}: use.parallel: expected boolean, received string`])
    expect(answer.paths).toEqual([CONFIG_FILE])
    // 432-11: NOTHING IS KEPT OR WRITTEN. The report is the answer.
    expect(test.filed).toHaveLength(0)
    expect(test.written).toHaveLength(0)
  })

  it('(4) the blocked summary line names the subject and drops the value the applyable one would print',
    async () => {
      const test = harness({
        config: CLEAN_CONFIG,
        validation: { ok: false, issues: [{ path: CONFIG_FILE, message: 'use.parallel: not a boolean' }] },
      })
      const payload = await propose(test, { path: 'parallel', value: 'yes please' })
      if (payload.outcome !== 'blocked') throw new Error('expected a blocked answer')

      // THE CHANNEL CAN CARRY IT: the applyable line prints the value.
      expect(configFieldSetSummaryLine('parallel', 'yes please')).toContain('yes please')

      expect(payload.summaryLine).not.toContain('yes please')
      expect(payload.summaryLine).toContain('parallel')
    })

  it('(7) a clean change is written, and carries the classifier\'s per-value verdict', async () => {
    const innocuous = harness({ config: CLEAN_CONFIG })
    const answer = await propose(innocuous, { path: 'use.timeout.step', value: '45s' })
    expect(answer.outcome).toBe('applied')
    if (answer.outcome !== 'applied') throw new Error('unreachable')
    expect(answer.crossBoundary).toBe(false)
    expect(answer.crossBoundaryReasons).toEqual([])

    // THE SAME PATH, A DIFFERENT VALUE — which is the whole of D-02 and the half a stub answering
    // `false` unconditionally cannot produce.
    const moved = harness({ config: CLEAN_CONFIG })
    const flagged = await propose(moved, { path: 'url', value: 'https://shop.evil.example/cart' })
    if (flagged.outcome !== 'applied') throw new Error('unreachable')
    expect(flagged.crossBoundary).toBe(true)
    expect(flagged.crossBoundaryReasons).toEqual(['new-origin'])

    const same = harness({ config: CLEAN_CONFIG })
    const unflagged = await propose(same, { path: 'url', value: 'https://shop.example.com/basket' })
    if (unflagged.outcome !== 'applied') throw new Error('unreachable')
    expect(unflagged.crossBoundary).toBe(false)
    expect(unflagged.crossBoundaryReasons).toEqual([])
  })

  // RE-SPELLED 2026-10-01 (432-17, D-05): nothing is filed any more, the accept op is deleted with
  // the inbox, and so is the funnel that guarded an apply port no host binds.
  it('(8) no blocked record can be accepted: there is no apply funnel and no accept op', () => {
    expect('applyablePayload' in construct).toBe(false)
    expect('BlockedConfigProposalError' in construct).toBe(false)
  })
})

// ---- 432-11 D-05/D-07: a blocked construction is an answer, never a record -------------------
//
// C432-CONFIG-BLOCKED-NO-WRITE  a blocked change answers a typed refusal with its report, and
//                               nothing reaches the proposal store or the direct writer.
// C432-CONFIG-APPLIED-OUTPUT    a clean change is written in the call, and the answer names the
//                               files and fields it changed, validated by the direct contract.

/** The harness above plus a direct writer that records every call it receives. */
function directHarness(options: Parameters<typeof harness>[0]) {
  const test = harness(options)
  const writes: unknown[] = []
  const deps = {
    ...test.deps,
    configWrite: {
      applyFields: (request: unknown) => {
        writes.push(request)
        return Promise.resolve({
          kind: 'applied' as const,
          file: CONFIG_FILE,
          revision: 'revision-after',
          baseRevision: 'revision-before',
        })
      },
      publishFiles: (request: unknown) => {
        writes.push(request)
        return Promise.resolve({ kind: 'published' as const, written: [CONFIG_FILE] })
      },
    },
  } as unknown as FunctionDeps
  return { test, deps, writes }
}

describe('a blocked change is refused in the call and nothing is kept', () => {
  it('schema-fail answers its issues, files no record and writes nothing',
    async () => {
      const { test, deps, writes } = directHarness({
        config: CLEAN_CONFIG,
        validation: {
          ok: false,
          issues: [{ path: CONFIG_FILE, message: 'use.parallel: expected boolean, received string' }],
        },
      })

      const answer = await configFieldSetSpec.invoke({ path: 'parallel', value: 'yes please' }, deps)

      expect(answer).toEqual({
        outcome: 'blocked',
        summaryLine: 'set parallel — blocked: the resulting configuration is not valid',
        blockedReason: 'schema-fail',
        paths: [CONFIG_FILE],
        validationIssues: [`${CONFIG_FILE}: use.parallel: expected boolean, received string`],
      })
      expect(test.filed).toEqual([])
      expect(writes).toEqual([])
    })
})

describe('the answer is what was written', () => {
  it('a clean change names its file, its field and its diff', async () => {
    const { test, deps, writes } = directHarness({ config: CLEAN_CONFIG })

    const answer = await configFieldSetSpec.invoke({ path: 'use.timeout.step', value: '45s' }, deps)

    expect(answer).toMatchObject({
      outcome: 'applied',
      summaryLine: 'set use.timeout.step to 45s',
      files: [CONFIG_FILE],
      fields: ['use.timeout.step'],
      crossBoundary: false,
      crossBoundaryReasons: [],
    })
    expect(answer).not.toHaveProperty('proposalId')
    expect((answer as { shownDiff?: string }).shownDiff).toContain('+    step: 45s')
    expect(writes).toEqual([
      { changes: [{ op: 'set', path: ['use', 'timeout', 'step'], value: '45s' }] },
    ])
    expect(test.filed).toEqual([])
  })

  it('the file named is the one the writer reports, not the one the call read',
    async () => {
      const { deps } = directHarness({ config: CLEAN_CONFIG })
      const renamed = {
        ...deps,
        configWrite: {
          ...deps.configWrite,
          applyFields: () => Promise.resolve({
            kind: 'applied' as const,
            file: 'sub/agent-qa.config.yaml',
            revision: 'revision-after',
            baseRevision: 'revision-before',
          }),
        },
      } as unknown as FunctionDeps

      const answer = await configFieldSetSpec.invoke({ path: 'use.timeout.step', value: '45s' }, renamed)
      expect(answer).toMatchObject({ outcome: 'applied', files: ['sub/agent-qa.config.yaml'] })
    })
})

// ---- 441 D-15/D-04/D-23: no config change is scanned for secrets ---------------------------------
//
// C441-CONFIG-SCAN  a credential-shaped value is written, a config that already carries one still
//                   yields its diff, and a reference field refuses only what is not a reference of
//                   its kind, pointing at the secrets file.

describe('credential-shaped values in config fields', () => {
  it('a credential-shaped value in a free-text field is written', async () => {
    const { test, deps, writes } = directHarness({ config: BUILD_TAG_CONFIG })

    const answer = await configFieldSetSpec.invoke({ path: 'use.buildTag', value: PROBE }, deps)

    expect(answer).toMatchObject({
      outcome: 'applied',
      files: [CONFIG_FILE],
      fields: ['use.buildTag'],
    })
    expect((answer as { shownDiff?: string }).shownDiff).toContain(`+  buildTag: ${PROBE}`)
    expect(writes).toEqual([
      { changes: [{ op: 'set', path: ['use', 'buildTag'], value: PROBE }] },
    ])
    expect(test.filed).toEqual([])
  })

  it('a config that already carries a credential-shaped value still yields its diff',
    async () => {
      const test = harness({ config: CONFIG_WITH_COMMITTED_BEARER })

      const answer = await propose(test, { path: 'step', value: '45s' })

      expect(answer.outcome).toBe('applied')
      if (answer.outcome !== 'applied') throw new Error('unreachable')
      expect(answer.shownDiff).toContain('+    step: 45s')
      expect(answer.shownDiff).toContain(COMMITTED_BEARER)
      expect(test.written).toHaveLength(1)
    })

  it('a reference field still refuses a value that is not a reference, naming the secrets file',
    async () => {
      const test = harness({ config: CLEAN_CONFIG })

      const answer = await setConfigAuth(
        { action: 'config.auth.set', target: 'shop', envVarName: PROBE },
        test.deps,
      )

      expect(answer).toMatchObject({ outcome: 'refused', reason: 'refs-only' })
      if (answer.outcome !== 'refused') throw new Error('unreachable')
      expect(answer.detail).toContain('envVarName')
      expect(answer.detail)
        .toContain('Put the secret in the secrets file the configuration names at workspace.secretsFile')
      expect(answer.detail).not.toContain('workspace.envFile')
      expect(answer.detail).not.toContain(PROBE)
      expect(test.written).toHaveLength(0)
    })
})
