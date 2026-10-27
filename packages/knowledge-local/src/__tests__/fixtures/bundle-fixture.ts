import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PROCEDURE_BODY_SCHEMA_VERSION,
  asRef,
  serializeProcedureBody,
} from '@vostride/agent-qa-schema'
import type {
  ArtifactRef,
  BundleDiscriminant,
  BundleDraft,
  ProcedureBodyPayload,
  ScreenState,
} from '@vostride/agent-qa-schema'

export const BUNDLE_FIXTURE_ARTIFACT_SHA =
  'd9113d37fe29084657c462ac5628ddd56519aeafad8883092a2596075878cbee'
export const BUNDLE_FIXTURE_ARTIFACT_BYTES = Uint8Array.from([
  97, 103, 101, 110, 116, 45, 113, 97, 32, 101, 118, 97, 108, 45, 108, 111, 99, 97, 108,
  32, 102, 105, 120, 116, 117, 114, 101, 32, 98, 108, 111, 98, 10,
])

const fixtureRef = asRef('e-sign-in')
const stepNames = ['Email', 'Password', 'Sign in'] as const

export const KNOWLEDGE_GITIGNORE_TEXT = `# agent-qa-knowledge/.gitignore
memory/index/
memory/queue/
.lease
.epoch
**/artifacts/        # binary blobs
                     # (artifact inventories are committed and live OUTSIDE artifacts/)
skills/.staging/
`

type KnowledgeIgnoreRule =
  | { kind: 'path-prefix'; value: string }
  | { kind: 'dir-name'; value: string }
  | { kind: 'file-name'; value: string }

export interface KnowledgeRootWalk {
  trackedPaths: string[]
  ignoredPaths: string[]
}

export function parseKnowledgeGitignoreRules(text: string): KnowledgeIgnoreRule[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((rule): KnowledgeIgnoreRule => {
      const doubledWildcard = /^\*\*\/([^/*]+)\/$/.exec(rule)
      if (doubledWildcard !== null) {
        return { kind: 'dir-name', value: doubledWildcard[1]! }
      }

      if (rule.endsWith('/')) {
        const value = rule.slice(0, -1)
        if (
          value === ''
          || value.startsWith('/')
          || value.includes('*')
          || value.split('/').some((segment) => segment === '' || segment === '..')
        ) {
          throw new Error(`unsupported scaffolded ignore rule: ${rule}`)
        }
        return { kind: 'path-prefix', value }
      }

      if (!rule.includes('/') && !rule.includes('*') && !rule.startsWith('!')) {
        return { kind: 'file-name', value: rule }
      }

      throw new Error(`unsupported scaffolded ignore rule: ${rule}`)
    })
}

function ignoredByRule(relPath: string, rule: KnowledgeIgnoreRule): boolean {
  const segments = relPath.split('/')
  switch (rule.kind) {
    case 'path-prefix':
      return relPath === rule.value || relPath.startsWith(`${rule.value}/`)
    case 'dir-name':
      return segments.slice(0, -1).includes(rule.value)
    case 'file-name':
      return segments.includes(rule.value)
  }
}

export function scaffoldKnowledgeRoot(root: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, '.gitignore'), KNOWLEDGE_GITIGNORE_TEXT, 'utf8')
}

export function walkKnowledgeRoot(root: string): KnowledgeRootWalk {
  const rules = parseKnowledgeGitignoreRules(readFileSync(join(root, '.gitignore'), 'utf8'))
  const trackedPaths: string[] = []
  const ignoredPaths: string[] = []

  function visit(relDir: string, parentIgnored: boolean): void {
    const dir = relDir === '' ? root : join(root, relDir)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      const ignored = parentIgnored || rules.some((rule) => ignoredByRule(relPath, rule))
      if (entry.isDirectory()) visit(relPath, ignored)
      else (ignored ? ignoredPaths : trackedPaths).push(relPath)
    }
  }

  visit('', false)
  return { trackedPaths: trackedPaths.sort(), ignoredPaths: ignoredPaths.sort() }
}

export function makeArtifactFixture(): {
  bytes: Uint8Array
  sha: string
  ref: ArtifactRef
} {
  return {
    bytes: Uint8Array.from(BUNDLE_FIXTURE_ARTIFACT_BYTES),
    sha: BUNDLE_FIXTURE_ARTIFACT_SHA,
    ref: {
      id: 'bundle-fixture-screenshot',
      sha: BUNDLE_FIXTURE_ARTIFACT_SHA,
    },
  }
}

export function makeBundleDraftFixture(
  overrides: Partial<BundleDraft> = {},
): BundleDraft {
  const kind = overrides.kind ?? 'fact'
  const defaultAnchors =
    kind === 'procedure'
      ? ([
          { t: 'flow', name: 'Sign in flow' },
          { t: 'page', route: '/login' },
        ] as const)
      : ([
          { t: 'el', role: 'Button', name: 'Sign in' },
          { t: 'page', route: '/login' },
        ] as const)

  return {
    kind,
    ...(kind === 'fact' ? { subtype: overrides.subtype ?? 'selector' } : {}),
    anchors: [...(overrides.anchors ?? defaultAnchors)],
    scope: overrides.scope ?? { tier: 'product', key: 'fixture-storefront' },
    summary: overrides.summary ?? 'Sign in control on the login page',
    body:
      overrides.body ??
      'Selecting Sign in submits the recorded credentials and advances to the account page.',
    distilledEvidenceRef: overrides.distilledEvidenceRef ?? makeArtifactFixture().ref,
    originStage: overrides.originStage ?? 'run-curation',
  }
}

/**
 * The 381-03 canonical codec-shaped procedure body: three parameterized steps aligned with
 * `makeProcedureScreenStateSequenceFixture` and the `enter-email`/`enter-password`/`submit`
 * distilled-observation natural keys used by procedure commit/disposition suites.
 */
export function makeProcedureBodyPayloadFixture(
  overrides: Partial<ProcedureBodyPayload> = {},
): ProcedureBodyPayload {
  return {
    schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
    parameters: [
      { name: 'email', type: 'string', required: true },
      { name: 'password', type: 'secret', required: true },
    ],
    steps: [
      {
        instruction: 'enter-email',
        action: {
          type: 'typeText',
          targets: { ref: { role: 'textbox', nameNormalized: 'email', ordinal: 0 } },
          values: { text: { param: 'email' } },
        },
        guard: {
          target: { role: 'textbox', nameNormalized: 'email', ordinal: 0 },
          pageAnchor: { t: 'page', route: '/login' },
        },
      },
      {
        instruction: 'enter-password',
        action: {
          type: 'typeText',
          targets: { ref: { role: 'textbox', nameNormalized: 'password', ordinal: 0 } },
          values: { text: { param: 'password' } },
        },
        guard: {
          target: { role: 'textbox', nameNormalized: 'password', ordinal: 0 },
          pageAnchor: { t: 'page', route: '/login' },
        },
      },
      {
        instruction: 'submit',
        action: {
          type: 'click',
          targets: { ref: { role: 'button', nameNormalized: 'sign in', ordinal: 0 } },
          values: {},
        },
        guard: {
          target: { role: 'button', nameNormalized: 'sign in', ordinal: 0 },
          pageAnchor: { t: 'page', route: '/login' },
        },
      },
    ],
    successAssertion: 'The account page is visible.',
    ...overrides,
  }
}

export function makeProcedureBundleDraftFixture(
  overrides: Partial<BundleDraft> = {},
): BundleDraft {
  return makeBundleDraftFixture({
    kind: 'procedure',
    anchors: [
      { t: 'flow', name: 'Sign in flow' },
      { t: 'page', route: '/login' },
    ],
    summary: 'Sign in with recorded credentials',
    body: serializeProcedureBody(makeProcedureBodyPayloadFixture()),
    ...overrides,
  })
}

export function makeScreenStateFixture(
  stepIndex = 0,
  overrides: Partial<ScreenState> = {},
): ScreenState {
  const name = stepNames[stepIndex % stepNames.length]!
  const role = name === 'Sign in' ? 'button' : 'textbox'
  const bounds = { x: 48, y: 120 + stepIndex * 56, width: 280, height: 44 }
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }

  return {
    platform: 'web',
    tree: `${role} ${name}`,
    elements: [
      {
        ref: fixtureRef,
        role,
        name,
        nameNormalized: name.toLowerCase(),
        bounds,
        center,
        state: { enabled: true, focused: stepIndex < 2, visible: true, clickable: true },
        labels: { ariaLabel: name },
        attributes: { 'data-fixture-step': String(stepIndex) },
      },
    ],
    refMap: {
      [fixtureRef]: {
        bounds,
        center,
        scrollContext: { offsetX: 0, offsetY: 0 },
      },
    } as ScreenState['refMap'],
    url: 'https://example.test/login',
    timestamp: 1_725_000_000_101 + stepIndex,
    metadata: {
      captureMode: 'full',
      coordSpace: 'viewport',
      viewportWidth: 1_280,
      viewportHeight: 720,
      imageWidth: 1_280,
      imageHeight: 720,
      scroll: {
        offsetX: 0,
        offsetY: 0,
        contentWidth: 1_280,
        contentHeight: 720,
      },
    },
    ...overrides,
  }
}

export function makeProcedureScreenStateSequenceFixture(): ScreenState[] {
  return [0, 1, 2].map((stepIndex) => makeScreenStateFixture(stepIndex))
}

export function makeDiscriminantFixture(
  kind: BundleDraft['kind'] = 'fact',
  subtype: NonNullable<BundleDraft['subtype']> = 'selector',
): BundleDiscriminant {
  switch (kind) {
    case 'fact':
      return subtype === 'measurement'
        ? { kind, subtype, metricKey: 'login latency p95' }
        : {
            kind,
            subtype,
            elementRef: { role: 'Button', name: 'Sign in' },
          }
    case 'procedure':
      return { kind, flowName: 'Sign in flow', stepSignature: 'email>password>submit' }
    case 'caution':
      return { kind, errorKey: 'authentication timed out' }
    case 'unknown':
      return { kind, conflictRecordIds: ['record-b', 'record-a'] }
    case 'policy':
      return { kind, ruleKey: 'never submit production credentials' }
  }
}
