import { describe, expect, it } from 'vitest'
import {
  buildScreenState,
  screenConformanceCases,
  type ConformanceInput,
  type InterimNode,
} from '@vostride/agent-qa-runner'
import { deriveMobileScroll, parseMobileSource } from '@vostride/agent-qa-core'
import { screenIdentityHash } from '@vostride/agent-qa-schema'

// iOS side of the shared adapter conformance spec (D-09). The XCUITest page source is
// lifted into platform-neutral interim nodes by parseMobileSource, then the ONE shared
// builder assembles the schema v2 ScreenState — so every case here runs against exactly
// the pipeline the live iOS observe() uses. The Android mirror of the cross-platform
// identity check lives in the android package (352-06); this file is self-sufficient.

const VIEWPORT = { width: 390, height: 844 }
const TIMESTAMP = 1_700_000_000_000

// A login-ish screen with nesting: an emitted Cell container wrapping two children,
// plus a selected+disabled Switch and a disabled Button — exercises value/selected/
// enabled mapping, typed-absence, and hierarchy-from-nesting in one fixture.
const IOS_PINS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="App" label="App" x="0" y="0" width="390" height="844">
    <XCUIElementTypeCell label="Row" x="0" y="100" width="390" height="80" enabled="true">
      <XCUIElementTypeStaticText label="Name" x="10" y="110" width="120" height="20" enabled="true" />
      <XCUIElementTypeTextField label="Email" value="a@b.com" x="10" y="140" width="200" height="30" enabled="true" />
    </XCUIElementTypeCell>
    <XCUIElementTypeSwitch label="Wifi" value="1" x="10" y="200" width="100" height="40" selected="true" enabled="false" />
    <XCUIElementTypeButton label="Disabled" x="10" y="260" width="100" height="40" enabled="false" />
  </XCUIElementTypeApplication>
</AppiumAUT>`

const IOS_LOGIN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="MyApp" label="MyApp" x="0" y="0" width="390" height="844">
    <XCUIElementTypeOther x="0" y="0" width="390" height="844">
      <XCUIElementTypeStaticText label="Welcome Back" x="20" y="100" width="350" height="30" enabled="true" />
      <XCUIElementTypeTextField label="Email" x="20" y="150" width="350" height="40" enabled="true" />
      <XCUIElementTypeSecureTextField label="Password" x="20" y="200" width="350" height="40" enabled="true" />
      <XCUIElementTypeButton label="Sign In" x="20" y="260" width="350" height="44" enabled="true" />
    </XCUIElementTypeOther>
  </XCUIElementTypeApplication>
</AppiumAUT>`

/** A fresh ConformanceInput factory: re-parses on every call so the determinism case
 *  materializes two fully independent builds. */
function makeIosInput(xml: string): () => ConformanceInput {
  return () => {
    const { nodes } = parseMobileSource(xml, 'ios', VIEWPORT)
    const scroll = deriveMobileScroll(nodes, VIEWPORT)
    return {
      platform: 'ios',
      nodes,
      buildInput: { viewport: VIEWPORT, scroll, coordSpace: 'viewport', timestamp: TIMESTAMP },
    }
  }
}

const IOS_FIXTURES: Record<string, string> = {
  'login-screen': IOS_LOGIN_XML,
  'nested-pins': IOS_PINS_XML,
}

describe('iOS adapter conformance — shared spec against the real parse→build pipeline', () => {
  for (const [kind, xml] of Object.entries(IOS_FIXTURES)) {
    describe(`fixture: ${kind}`, () => {
      const make = makeIosInput(xml)
      for (const conformanceCase of screenConformanceCases) {
        it(conformanceCase.name, () => {
          expect(() => conformanceCase.run(make)).not.toThrow()
        })
      }
    })
  }
})

describe('iOS attribute mapping — truthful, no fabrication', () => {
  const make = makeIosInput(IOS_PINS_XML)
  const build = () => buildScreenState({ platform: 'ios', nodes: make().nodes, ...make().buildInput })

  it('maps XCUITest value onto ElementInfo.value', () => {
    const { state } = build()
    const email = state.elements.find(e => e.name === 'Email')
    expect(email).toBeDefined()
    expect(email!.value).toBe('a@b.com')
  })

  it('maps selected and enabled truthfully', () => {
    const { state } = build()
    const wifi = state.elements.find(e => e.name === 'Wifi')
    expect(wifi).toBeDefined()
    expect(wifi!.state.selected).toBe(true)
    expect(wifi!.state.enabled).toBe(false)
    const disabled = state.elements.find(e => e.name === 'Disabled')
    expect(disabled!.state.enabled).toBe(false)
  })

  it('lifts a switch value "1" to checked true and renders [checked]', () => {
    const { state } = build()
    const wifi = state.elements.find(e => e.name === 'Wifi')
    expect(wifi!.state.checked).toBe(true)
    expect(state.tree).toContain('- switch "Wifi" [ref=e4] @(10,200 100x40) [disabled] [checked] [selected]')
  })

  it('leaves signals the platform did not emit typed-absent', () => {
    const { state } = build()
    const name = state.elements.find(e => e.name === 'Name')
    // StaticText emitted no selected/checked/focused-negating signals.
    expect('selected' in name!.state).toBe(false)
    expect('checked' in name!.state).toBe(false)
  })

  it('derives hierarchy from XML nesting (cell → its children)', () => {
    const { state } = build()
    const cell = state.elements.find(e => e.name === 'Row')
    const name = state.elements.find(e => e.name === 'Name')
    const email = state.elements.find(e => e.name === 'Email')
    expect(cell).toBeDefined()
    expect(name!.hierarchy?.parentRef).toBe(cell!.ref)
    expect(email!.hierarchy?.parentRef).toBe(cell!.ref)
    expect(cell!.hierarchy?.childRefs).toContain(name!.ref)
    expect(cell!.hierarchy?.childRefs).toContain(email!.ref)
  })

  it('flows the best-effort deriveMobileScroll approximation into metadata.scroll', () => {
    const input = make()
    const { state } = buildScreenState({ platform: 'ios', nodes: input.nodes, ...input.buildInput })
    const expected = deriveMobileScroll(input.nodes, VIEWPORT)
    expect(state.metadata.scroll).toEqual(expected)
    // Documented approximation: zero scroll offset, content extent ≥ viewport.
    expect(state.metadata.scroll.offsetY).toBe(0)
    expect(state.metadata.scroll.contentHeight).toBeGreaterThanOrEqual(VIEWPORT.height)
  })
})

describe('cross-platform identity — one builder, not the platform walker', () => {
  const IDENTITY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="App" label="App" x="0" y="0" width="390" height="844">
    <XCUIElementTypeStaticText label="Hello" x="10" y="20" width="120" height="30" enabled="true" />
    <XCUIElementTypeButton label="Submit" x="10" y="60" width="120" height="44" enabled="true" />
  </XCUIElementTypeApplication>
</AppiumAUT>`

  it('an iOS parse and hand-built platform-neutral nodes yield the same screenIdentityHash', () => {
    const { nodes: iosNodes } = parseMobileSource(IDENTITY_XML, 'ios', VIEWPORT)
    const scroll = deriveMobileScroll(iosNodes, VIEWPORT)

    // The SAME semantic screen, described as platform-neutral interim nodes with the
    // identical roles/names/geometry — built under a different platform label to prove
    // identity comes from the one builder, independent of the platform walker.
    const neutralNodes: InterimNode[] = [
      { role: 'text', name: 'Hello', bounds: { x: 10, y: 20, width: 120, height: 30 } },
      { role: 'button', name: 'Submit', bounds: { x: 10, y: 60, width: 120, height: 44 } },
    ]

    const iosBuild = buildScreenState({
      platform: 'ios',
      nodes: iosNodes,
      viewport: VIEWPORT,
      scroll,
      coordSpace: 'viewport',
      timestamp: TIMESTAMP,
    })
    const neutralBuild = buildScreenState({
      platform: 'android',
      nodes: neutralNodes,
      viewport: VIEWPORT,
      scroll,
      coordSpace: 'viewport',
      timestamp: TIMESTAMP,
    })

    expect(screenIdentityHash(iosBuild.state)).toBe(screenIdentityHash(neutralBuild.state))
  })
})
