// Shared v2 ScreenState test fixtures for the runner + all three adapter packages.
// CRITICAL: framework-free — imports NOTHING from any test framework (this module ships
// in the runner barrel; adapter test files supply the it()/expect wrappers). Modeled on the
// schema `makeState` fixture (schema/src/__tests__/screen-hash.test.ts) so the ~27
// legacy-fixture test files migrate to one canonical factory.

import { asRef, type ScreenState } from '@vostride/agent-qa-schema'
import type { BuildScreenStateInput, InterimNode } from '../screen-builder.js'

/**
 * A complete, valid v2 `ScreenState` with `captureMode: 'textOnly'`. Callers override
 * individual fields; the base is deterministic (fixed refs/bounds/timestamp/scroll).
 */
export function makeScreenState(overrides: Partial<ScreenState> = {}): ScreenState {
  const inputRef = asRef('e1')
  const buttonRef = asRef('e2')
  const inputBounds = { x: 20, y: 120, width: 350, height: 44 }
  const buttonBounds = { x: 20, y: 200, width: 350, height: 44 }

  const base: ScreenState = {
    platform: 'web',
    tree: [
      '[Viewport: 390x844] [2 elements]',
      '- textbox "Email" [ref=e1] @(20,120 350x44)',
      '- button "Log in" [ref=e2] @(20,200 350x44)',
    ].join('\n'),
    elements: [
      {
        ref: inputRef,
        role: 'textbox',
        name: 'Email',
        nameNormalized: 'email',
        bounds: inputBounds,
        center: { x: 195, y: 142 },
        state: { enabled: true, focused: false, visible: true },
        labels: { placeholder: 'Email' },
        attributes: {},
      },
      {
        ref: buttonRef,
        role: 'button',
        name: 'Log in',
        nameNormalized: 'log in',
        bounds: buttonBounds,
        center: { x: 195, y: 222 },
        state: { enabled: true, focused: false, visible: true },
        labels: { ariaLabel: 'Log in' },
        attributes: {},
      },
    ],
    refMap: {
      [inputRef]: { bounds: inputBounds, center: { x: 195, y: 142 } },
      [buttonRef]: { bounds: buttonBounds, center: { x: 195, y: 222 } },
    },
    url: 'https://example.test/login',
    timestamp: 1700000000000,
    metadata: {
      captureMode: 'textOnly',
      coordSpace: 'viewport',
      viewportWidth: 390,
      viewportHeight: 844,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 390, contentHeight: 844 },
    },
  }

  return { ...base, ...overrides }
}

/** The platform-neutral node list + the builder input (minus nodes/platform). */
export interface InterimFixture {
  nodes: InterimNode[]
  buildInput: Omit<BuildScreenStateInput, 'nodes' | 'platform'>
}

export type InterimFixtureKind = 'login-screen' | 'mixed-geometry' | 'nested'

// Fixed constants so every fixture builds to deterministic output regardless of platform.
const FIXED_BUILD_INPUT: Omit<BuildScreenStateInput, 'nodes' | 'platform'> = {
  viewport: { width: 390, height: 844 },
  scroll: { offsetX: 0, offsetY: 0, contentWidth: 390, contentHeight: 844 },
  coordSpace: 'viewport',
  timestamp: 1700000000000,
}

const FIXTURE_NODES: Record<InterimFixtureKind, InterimNode[]> = {
  // A form: heading (root) + a container form with three bounded children.
  'login-screen': [
    { role: 'heading', name: 'Sign in', bounds: { x: 20, y: 60, width: 350, height: 32 } },
    { role: 'form', name: 'Login', bounds: { x: 10, y: 100, width: 370, height: 300 } },
    {
      role: 'textbox',
      name: 'Email',
      parentIndex: 1,
      bounds: { x: 20, y: 120, width: 350, height: 44 },
      labels: { placeholder: 'Email' },
    },
    {
      role: 'textbox',
      name: 'Password',
      parentIndex: 1,
      bounds: { x: 20, y: 180, width: 350, height: 44 },
      labels: { placeholder: 'Password' },
    },
    {
      role: 'button',
      name: 'Log In',
      parentIndex: 1,
      bounds: { x: 20, y: 240, width: 350, height: 44 },
      state: { enabled: true },
    },
  ],
  // Mix of bounded and boundsless nodes — exercises the refMap geometry rule.
  'mixed-geometry': [
    { role: 'group', name: 'Container' },
    { role: 'button', name: 'Save', parentIndex: 0, bounds: { x: 10, y: 10, width: 100, height: 40 } },
    { role: 'text', name: 'Status message' },
    { role: 'link', name: 'Help', bounds: { x: 200, y: 10, width: 60, height: 20 } },
  ],
  // Deep parentIndex chain — exercises multi-level hierarchy translation.
  nested: [
    { role: 'main', name: 'Root', bounds: { x: 0, y: 0, width: 390, height: 844 } },
    { role: 'section', name: 'Section', parentIndex: 0, bounds: { x: 0, y: 50, width: 390, height: 400 } },
    { role: 'group', name: 'Group', parentIndex: 1, bounds: { x: 0, y: 100, width: 390, height: 200 } },
    { role: 'button', name: 'Deep', parentIndex: 2, bounds: { x: 20, y: 120, width: 100, height: 40 } },
  ],
}

/**
 * Platform-neutral interim nodes plus the matching builder input for a scenario. The
 * conformance cases feed these through `buildScreenState` (per platform) to assert the
 * shared contract holds identically across all three adapters.
 */
export function makeInterimNodes(kind: InterimFixtureKind): InterimFixture {
  return {
    nodes: FIXTURE_NODES[kind].map(node => ({ ...node })),
    buildInput: { ...FIXED_BUILD_INPUT },
  }
}
