import { describe, it, expect } from 'vitest'
import { buildScreenState, screenConformanceCases, type ConformanceInput } from '@vostride/agent-qa-runner'
import { parseMobileSource, deriveMobileScroll } from '@vostride/agent-qa-core'

// The shared adapter conformance suite run against the ANDROID native walk: real
// UiAutomator2 page-source XML is fed through parseMobileSource into the interim nodes the
// builder consumes, then every case in screenConformanceCases asserts the pinned
// builder-contract invariants over those nodes. Beyond the shared cases, android-specific
// pins assert the D-08 attribute lift (resource-id/content-desc → labels; checked/
// selected/focused truthfully mapped with typed-absence) and the D-10 best-effort scroll.

const VIEWPORT = { width: 1080, height: 1920 }
// Fixed so repeated builds are byte-identical (the determinism case builds twice and
// compares screenStateHash).
const FIXED_TIMESTAMP = 1_700_000_000_000

// Nested login screen — structural containers (FrameLayout/LinearLayout) are filtered, so
// the emitted nodes reparent to the nearest surviving ancestor (exercises hierarchy).
const ANDROID_LOGIN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,1920]">
    <android.widget.LinearLayout bounds="[0,0][1080,1920]">
      <android.widget.TextView text="Welcome Back" resource-id="title" bounds="[100,200][980,280]" enabled="true" />
      <android.widget.EditText content-desc="Email" resource-id="email" text="" bounds="[100,300][980,380]" enabled="true" />
      <android.widget.EditText content-desc="Password" resource-id="password" text="" bounds="[100,400][980,480]" enabled="true" />
      <android.widget.Button text="Sign In" resource-id="login" bounds="[100,500][980,580]" enabled="true" />
      <android.widget.ImageView content-desc="App Logo" resource-id="logo" bounds="[400,700][680,900]" enabled="true" />
    </android.widget.LinearLayout>
  </android.widget.FrameLayout>
</hierarchy>`

// State fixture: a fully-signalled checkbox (checkable/checked/selected/focused +
// resource-id + content-desc) beside a plain button that carries none of those signals.
const ANDROID_STATE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,1920]">
    <android.widget.CheckBox text="Remember me" resource-id="com.app:id/remember" content-desc="Remember me toggle" bounds="[100,200][980,300]" checkable="true" checked="true" selected="true" focused="true" enabled="true" />
    <android.widget.Button text="Sign In" bounds="[100,400][980,500]" enabled="true" />
  </android.widget.FrameLayout>
</hierarchy>`

function makeAndroidInput(): ConformanceInput {
  const { nodes } = parseMobileSource(ANDROID_LOGIN_XML, 'android', VIEWPORT)
  return {
    platform: 'android',
    nodes,
    buildInput: {
      viewport: VIEWPORT,
      scroll: deriveMobileScroll(nodes, VIEWPORT),
      coordSpace: 'viewport',
      timestamp: FIXED_TIMESTAMP,
    },
  }
}

describe('android adapter conformance (shared cases)', () => {
  // Iterate the FULL exported case list — no cherry-picking.
  for (const conformanceCase of screenConformanceCases) {
    it(conformanceCase.name, () => {
      expect(() => conformanceCase.run(makeAndroidInput)).not.toThrow()
    })
  }

  // --- Android-specific pins beyond the shared cases (D-08 attribute lift) ---

  it('resource-id → labels.testId and content-desc → labels.ariaLabel', () => {
    const { nodes } = parseMobileSource(ANDROID_STATE_XML, 'android', VIEWPORT)
    const { state } = buildScreenState({ platform: 'android', nodes, viewport: VIEWPORT, scroll: deriveMobileScroll(nodes, VIEWPORT), coordSpace: 'viewport', timestamp: FIXED_TIMESTAMP })

    // content-desc is the accessible name (takes priority over text in the android lift).
    const checkbox = state.elements.find(e => e.name === 'Remember me toggle')!
    expect(checkbox.labels.testId).toBe('com.app:id/remember')
    expect(checkbox.labels.ariaLabel).toBe('Remember me toggle')
  })

  it('maps checked/selected/focused truthfully; absent signals stay typed-absent', () => {
    const { nodes } = parseMobileSource(ANDROID_STATE_XML, 'android', VIEWPORT)
    const { state } = buildScreenState({ platform: 'android', nodes, viewport: VIEWPORT, scroll: deriveMobileScroll(nodes, VIEWPORT), coordSpace: 'viewport', timestamp: FIXED_TIMESTAMP })

    // content-desc is the accessible name (takes priority over text in the android lift).
    const checkbox = state.elements.find(e => e.name === 'Remember me toggle')!
    expect(checkbox.state.checked).toBe(true)
    expect(checkbox.state.selected).toBe(true)
    expect(checkbox.state.focused).toBe(true)
    expect(checkbox.state.enabled).toBe(true)

    // The plain button emitted none of those signals — the optional bits must be absent
    // (never fabricated), and focused falls back to the builder default false.
    const button = state.elements.find(e => e.name === 'Sign In')!
    expect('checked' in button.state).toBe(false)
    expect('selected' in button.state).toBe(false)
    expect(button.state.focused).toBe(false)
    expect(button.labels.testId).toBeUndefined()
    expect(button.labels.ariaLabel).toBeUndefined()
  })

  it('flows deriveMobileScroll output into metadata.scroll (best-effort approximation)', () => {
    const { nodes } = parseMobileSource(ANDROID_LOGIN_XML, 'android', VIEWPORT)
    const scroll = deriveMobileScroll(nodes, VIEWPORT)
    const { state } = buildScreenState({ platform: 'android', nodes, viewport: VIEWPORT, scroll, coordSpace: 'viewport', timestamp: FIXED_TIMESTAMP })

    expect(state.metadata.scroll).toEqual(scroll)
    // Documented approximation: zero offsets, content extent never smaller than viewport.
    expect(state.metadata.scroll.offsetX).toBe(0)
    expect(state.metadata.scroll.offsetY).toBe(0)
    expect(state.metadata.scroll.contentWidth).toBeGreaterThanOrEqual(VIEWPORT.width)
    expect(state.metadata.scroll.contentHeight).toBeGreaterThanOrEqual(VIEWPORT.height)
  })

  it('produces a schema v2 android ScreenState (platform tag + textOnly capture)', () => {
    const input = makeAndroidInput()
    const { state } = buildScreenState({ platform: input.platform, nodes: input.nodes, ...input.buildInput })

    expect(state.platform).toBe('android')
    expect(state.metadata.captureMode).toBe('textOnly')
    // Every bounded node lands in refMap; the login fixture is fully bounded.
    expect(Object.keys(state.refMap).length).toBe(state.elements.length)
  })
})
