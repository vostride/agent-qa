// C438-ROW-MOBILE (438 D-02, RESEARCH Open Question 3): the runner's one row definition over iOS
// and Android page sources. On iOS an XCUIElementTypeCell is the row container; on Android layout
// groups are filtered out of the observation, so a list row's text is unknown and a stated row
// there never refuses. Page sources are inline strings.

import { describe, expect, it } from 'vitest'
import {
  buildScreenState,
  judgeStatedTarget,
  ROW_CONTAINER_ROLES,
  rowContains,
  rowTextOf,
  wordTokens,
} from '@vostride/agent-qa-runner'
import type { StatedTarget, StatedTargets } from '@vostride/agent-qa-runner'
import type { ElementInfo } from '@vostride/agent-qa-schema'
import { parseMobileSource } from '../xml-parser.js'

const IOS_ADDRESSES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="App" label="App">
    <XCUIElementTypeWindow x="0" y="0" width="390" height="844">
      <XCUIElementTypeTable x="0" y="0" width="390" height="844">
        <XCUIElementTypeCell x="0" y="100" width="390" height="80" enabled="true">
          <XCUIElementTypeStaticText label="7 Elm Street" x="20" y="110" width="250" height="30" enabled="true" />
          <XCUIElementTypeButton label="Edit label" x="280" y="110" width="90" height="44" enabled="true" />
        </XCUIElementTypeCell>
        <XCUIElementTypeCell x="0" y="180" width="390" height="80" enabled="true">
          <XCUIElementTypeStaticText label="1 Home Street" x="20" y="190" width="250" height="30" enabled="true" />
          <XCUIElementTypeButton label="Edit label" x="280" y="190" width="90" height="44" enabled="true" />
        </XCUIElementTypeCell>
      </XCUIElementTypeTable>
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`

const ANDROID_ADDRESSES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <androidx.recyclerview.widget.RecyclerView bounds="[0,0][1080,1920]" resource-id="addresses" content-desc="" text="" enabled="true">
    <android.view.ViewGroup bounds="[0,0][1080,200]" resource-id="" content-desc="" text="" enabled="true">
      <android.widget.TextView bounds="[40,40][700,120]" resource-id="street" content-desc="" text="7 Elm Street" enabled="true" />
      <android.widget.Button bounds="[760,40][1040,160]" resource-id="edit" content-desc="" text="Edit label" enabled="true" />
    </android.view.ViewGroup>
    <android.view.ViewGroup bounds="[0,200][1080,400]" resource-id="" content-desc="" text="" enabled="true">
      <android.widget.TextView bounds="[40,240][700,320]" resource-id="street" content-desc="" text="1 Home Street" enabled="true" />
      <android.widget.Button bounds="[760,240][1040,360]" resource-id="edit" content-desc="" text="Edit label" enabled="true" />
    </android.view.ViewGroup>
  </androidx.recyclerview.widget.RecyclerView>
</hierarchy>`

function observe(xml: string, platform: 'android' | 'ios'): ElementInfo[] {
  const viewport = platform === 'ios' ? { width: 390, height: 844 } : { width: 1080, height: 1920 }
  const { nodes } = parseMobileSource(xml, platform, viewport)
  return buildScreenState({
    platform,
    nodes,
    viewport,
    scroll: { offsetX: 0, offsetY: 0, contentWidth: viewport.width, contentHeight: viewport.height },
    coordSpace: 'viewport',
    timestamp: 0,
  }).state.elements
}

function editButtons(elements: ElementInfo[]): ElementInfo[] {
  return elements.filter((element) => element.role === 'button' && element.name === 'Edit label')
}

describe('C438-ROW-MOBILE', () => {
  it("an iOS cell is the Edit label button's row", () => {
    const elements = observe(IOS_ADDRESSES_XML, 'ios')
    const [elm, home] = editButtons(elements)

    expect(rowTextOf(elm, elements)).toContain('7 Elm Street')
    expect(rowTextOf(elm, elements)).not.toContain('1 Home Street')
    expect(rowTextOf(home, elements)).toContain('1 Home Street')
  })

  it("a stated row that is not the iOS cell's row is a 'row' contradiction", () => {
    const elements = observe(IOS_ADDRESSES_XML, 'ios')
    const [elm] = editButtons(elements)
    const stated: StatedTarget = { role: 'button', name: 'Edit label', row: '1 Home Street' }

    const judgement = judgeStatedTarget(stated, elm, elements)
    expect(judgement.verdict).toBe('contradicts')
    expect(judgement).toMatchObject({ reasons: ['row'], rowStated: true })
    expect(judgement.observedRow).toContain('7 Elm Street')
  })

  it('an Android list row has unknown row text', () => {
    const elements = observe(ANDROID_ADDRESSES_XML, 'android')
    const buttons = editButtons(elements)

    expect(buttons).toHaveLength(2)
    for (const button of buttons) expect(rowTextOf(button, elements)).toBeUndefined()
  })

  it('a stated row on an Android button agrees with rowKnown false', () => {
    const elements = observe(ANDROID_ADDRESSES_XML, 'android')
    const [elm] = editButtons(elements)
    const lanes: StatedTargets = {
      ref: { role: 'button', name: 'Edit label', row: '1 Home Street' },
    }

    expect(judgeStatedTarget(lanes.ref!, elm, elements)).toEqual({
      verdict: 'agrees',
      rowStated: true,
      rowKnown: false,
    })
  })

  it('the row definition is importable from the runner root', () => {
    expect(ROW_CONTAINER_ROLES).toContain('listitem')
    expect(rowContains('7 Elm Street', 'Elm St')).toBe(true)
    expect(wordTokens('7 Elm Street')).toEqual(['7', 'elm', 'street'])
  })
})
