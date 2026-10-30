import { describe, it, expect } from 'vitest'
import { buildScreenState } from '@vostride/agent-qa-runner'
import { isToggleElement, screenIdentityHash } from '@vostride/agent-qa-schema'
import type { ScreenState } from '@vostride/agent-qa-schema'
import { parseMobileSource, buildRefEntries, deriveMobileScroll } from '../xml-parser.js'
import { normalizeRole, ANDROID_ROLE_MAP, IOS_ROLE_MAP } from '../role-map.js'
import { MobileElementResolver } from '../element-resolver.js'

const ANDROID_LOGIN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,1920]" resource-id="" content-desc="" text="" enabled="true">
    <android.widget.LinearLayout bounds="[0,0][1080,1920]" resource-id="" content-desc="" text="" enabled="true">
      <android.widget.TextView bounds="[100,200][980,280]" resource-id="title" content-desc="" text="Welcome Back" enabled="true" />
      <android.widget.EditText bounds="[100,300][980,380]" resource-id="email" content-desc="Email" text="" enabled="true" />
      <android.widget.EditText bounds="[100,400][980,480]" resource-id="password" content-desc="Password" text="" enabled="true" />
      <android.widget.Button bounds="[100,500][980,580]" resource-id="login" content-desc="" text="Sign In" enabled="true" />
      <android.widget.Button bounds="[100,600][980,680]" resource-id="register" content-desc="" text="Sign Up" enabled="true" />
      <android.widget.ImageView bounds="[400,700][680,900]" resource-id="logo" content-desc="App Logo" enabled="true" />
    </android.widget.LinearLayout>
  </android.widget.FrameLayout>
</hierarchy>`

const IOS_LOGIN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="MyApp" label="MyApp">
    <XCUIElementTypeWindow x="0" y="0" width="390" height="844">
      <XCUIElementTypeOther x="0" y="0" width="390" height="844">
        <XCUIElementTypeStaticText label="Welcome Back" x="20" y="100" width="350" height="30" enabled="true" />
        <XCUIElementTypeTextField label="Email" x="20" y="150" width="350" height="40" enabled="true" />
        <XCUIElementTypeSecureTextField label="Password" x="20" y="200" width="350" height="40" enabled="true" />
        <XCUIElementTypeButton label="Sign In" x="20" y="260" width="350" height="44" enabled="true" />
        <XCUIElementTypeButton label="Sign Up" x="20" y="320" width="350" height="44" enabled="true" />
        <XCUIElementTypeImage label="App Logo" x="120" y="400" width="150" height="150" enabled="true" />
      </XCUIElementTypeOther>
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`

const IOS_SHEET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Bluesky" label="Bluesky" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0">
    <XCUIElementTypeWindow type="XCUIElementTypeWindow" enabled="true" visible="true" accessible="false" x="0" y="0" width="402" height="874" index="0">
      <XCUIElementTypeOther type="XCUIElementTypeOther" enabled="true" visible="true" accessible="false" x="0" y="474" width="402" height="400" index="0">
        <XCUIElementTypeOther type="XCUIElementTypeOther" name="profileHeaderDropdownMuteBtn" label="Mute account" enabled="true" visible="true" accessible="true" x="31" y="715" width="340" height="43" index="4" traits=""/>
        <XCUIElementTypeOther type="XCUIElementTypeOther" name="profileHeaderDropdownBlockBtn" label="Block account" enabled="true" visible="true" accessible="true" x="31" y="758" width="340" height="43" index="5" traits=""/>
        <XCUIElementTypeOther type="XCUIElementTypeOther" name="profileHeaderDropdownReportBtn" label="Report account" enabled="true" visible="true" accessible="true" x="31" y="801" width="340" height="43" index="6" traits=""/>
      </XCUIElementTypeOther>
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`

const IOS_VIEWPORT = { width: 402, height: 874 }

function iosScreen(body: string, windowAttrs = 'x="0" y="0" width="402" height="874"'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="App" label="App">
    <XCUIElementTypeWindow ${windowAttrs}>
      ${body}
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`
}

describe('parseMobileSource → InterimNode[]', () => {
  describe('Android walk', () => {
    it('emits interactive/content nodes in document order (containers filtered)', () => {
      const { nodes } = parseMobileSource(ANDROID_LOGIN_XML, 'android')

      const roles = nodes.map(n => n.role)
      // FrameLayout/LinearLayout (group) are structural containers — never emitted.
      expect(roles).not.toContain('group')
      expect(roles).toEqual(['text', 'textbox', 'textbox', 'button', 'button', 'image'])

      const names = nodes.map(n => n.name)
      expect(names).toEqual(['Welcome Back', 'Email', 'Password', 'Sign In', 'Sign Up', 'App Logo'])
    })

    it('carries no ref, tree line, or ordinal on nodes', () => {
      const { nodes } = parseMobileSource(ANDROID_LOGIN_XML, 'android')
      for (const node of nodes) {
        expect(node).not.toHaveProperty('ref')
        expect(node).not.toHaveProperty('nth')
        expect(node).not.toHaveProperty('line')
      }
    })

    it('parses Android bounds correctly', () => {
      const { nodes } = parseMobileSource(ANDROID_LOGIN_XML, 'android')
      const email = nodes.find(n => n.name === 'Email')!
      expect(email.bounds).toEqual({ x: 100, y: 300, width: 880, height: 80 })
    })

    it('maps resource-id → labels.testId and content-desc → labels.ariaLabel', () => {
      const { nodes } = parseMobileSource(ANDROID_LOGIN_XML, 'android')

      const title = nodes.find(n => n.name === 'Welcome Back')!
      expect(title.labels?.testId).toBe('title')
      // content-desc was empty → ariaLabel typed-absent.
      expect(title.labels?.ariaLabel).toBeUndefined()

      const logo = nodes.find(n => n.name === 'App Logo')!
      expect(logo.labels?.testId).toBe('logo')
      expect(logo.labels?.ariaLabel).toBe('App Logo')
    })

    it('retains the raw platform attribute bag and nativeType', () => {
      const { nodes } = parseMobileSource(ANDROID_LOGIN_XML, 'android')
      const signIn = nodes.find(n => n.name === 'Sign In')!
      expect(signIn.nativeType).toBe('android.widget.Button')
      expect(signIn.attributes?.['resource-id']).toBe('login')
      expect(signIn.attributes?.text).toBe('Sign In')
      expect(signIn.attributes?.enabled).toBe('true')
    })

    it('lifts the full Android state signals only when the attribute is present', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.CheckBox bounds="[0,0][100,100]" text="Agree" content-desc="Accept terms" resource-id="agree" checkable="true" checked="true" selected="false" focused="true" scrollable="false" enabled="true" />
</hierarchy>`
      const { nodes } = parseMobileSource(xml, 'android')
      const cb = nodes[0]

      expect(cb.role).toBe('checkbox')
      expect(cb.state?.enabled).toBe(true)
      expect(cb.state?.checked).toBe(true)
      expect(cb.state?.selected).toBe(false)
      expect(cb.state?.focused).toBe(true)
      // scrollable stays in the raw bag (scroll-derivation input), never on state.
      expect(cb.attributes?.scrollable).toBe('false')
      expect('scrollable' in (cb.state ?? {})).toBe(false)
    })

    it('leaves checked typed-absent when the widget is not checkable', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.Button bounds="[0,0][100,100]" text="Go" checkable="false" checked="false" enabled="true" />
</hierarchy>`
      const { nodes } = parseMobileSource(xml, 'android')
      // No fabricated checked signal for a non-checkable control.
      expect('checked' in (nodes[0].state ?? {})).toBe(false)
    })

    it('derives visible=false for bounds fully outside the viewport, absent otherwise', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.Button bounds="[0,2000][500,2100]" text="Below" enabled="true" />
  <android.widget.Button bounds="[0,100][500,200]" text="OnScreen" enabled="true" />
</hierarchy>`
      const { nodes } = parseMobileSource(xml, 'android', { width: 1080, height: 1920 })
      const below = nodes.find(n => n.name === 'Below')!
      const onScreen = nodes.find(n => n.name === 'OnScreen')!
      expect(below.state?.visible).toBe(false)
      expect('visible' in (onScreen.state ?? {})).toBe(false)
    })
  })

  describe('parentIndex nesting', () => {
    it('links children to the nearest surviving ancestor across filtered containers', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.LinearLayout bounds="[0,0][1080,1920]" text="" enabled="true">
    <android.widget.Button bounds="[0,0][500,100]" text="Outer" enabled="true">
      <android.widget.LinearLayout bounds="[0,0][500,100]" text="" enabled="true">
        <android.widget.TextView bounds="[10,10][100,40]" text="Inner" enabled="true" />
      </android.widget.LinearLayout>
    </android.widget.Button>
  </android.widget.LinearLayout>
</hierarchy>`
      const { nodes } = parseMobileSource(xml, 'android')

      expect(nodes.map(n => n.name)).toEqual(['Outer', 'Inner'])
      const outer = nodes[0]
      const inner = nodes[1]
      // Outer's parent (LinearLayout) filtered → root.
      expect(outer.parentIndex).toBeUndefined()
      // Inner collapses through the skipped intermediate LinearLayout to Outer (index 0).
      expect(inner.parentIndex).toBe(0)
    })
  })

  describe('iOS walk', () => {
    it('emits interactive/content nodes with correct roles and names', () => {
      const { nodes } = parseMobileSource(IOS_LOGIN_XML, 'ios')
      const roles = nodes.map(n => n.role)
      expect(roles).toEqual(['text', 'textbox', 'textbox', 'button', 'button', 'image'])

      const names = nodes.map(n => n.name)
      expect(names).toEqual(['Welcome Back', 'Email', 'Password', 'Sign In', 'Sign Up', 'App Logo'])
    })

    it('parses iOS bounds from individual attributes', () => {
      const { nodes } = parseMobileSource(IOS_LOGIN_XML, 'ios')
      const email = nodes.find(n => n.name === 'Email')!
      expect(email.bounds).toEqual({ x: 20, y: 150, width: 350, height: 40 })
    })

    it('maps value/selected/enabled and lifts a switch value "1" to checked true', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeSwitch label="Wifi" value="1" x="10" y="20" width="100" height="40" selected="true" enabled="false" />
</AppiumAUT>`
      const { nodes } = parseMobileSource(xml, 'ios')
      const sw = nodes[0]

      expect(sw.role).toBe('switch')
      expect(sw.value).toBe('1')
      expect(sw.state?.selected).toBe(true)
      expect(sw.state?.enabled).toBe(false)
      expect(sw.state?.checked).toBe(true)
    })

    it('preserves native metadata for iOS picker wheel controls', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypePickerWheel value="March" x="20" y="300" width="350" height="80" enabled="true" />
</AppiumAUT>`
      const { nodes } = parseMobileSource(xml, 'ios')
      const picker = nodes[0]
      expect(['pickerwheel', 'spinbutton']).toContain(picker.role)
      expect(picker.name).toBe('March')
      expect(picker.value).toBe('March')
      expect(picker.nativeType).toBe('XCUIElementTypePickerWheel')
    })

    it('marks iOS text-entry types editable; a TextView keeps the text role', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeTextView label="Body" x="10" y="10" width="300" height="120" enabled="true" />
  <XCUIElementTypeTextField label="Title" x="10" y="140" width="300" height="40" enabled="true" />
  <XCUIElementTypeSecureTextField label="Pin" x="10" y="190" width="300" height="40" enabled="true" />
  <XCUIElementTypeSearchField label="Search" x="10" y="240" width="300" height="40" enabled="true" />
  <XCUIElementTypeStaticText label="Heading" x="10" y="290" width="300" height="30" enabled="true" />
  <XCUIElementTypeTextView label="Locked" x="10" y="330" width="300" height="120" enabled="false" />
</AppiumAUT>`
      const { nodes } = parseMobileSource(xml, 'ios')
      const byName = (name: string) => nodes.find(n => n.name === name)!

      expect(byName('Body').role).toBe('text')
      expect(byName('Body').state?.editable).toBe(true)
      expect(byName('Title').state?.editable).toBe(true)
      expect(byName('Pin').state?.editable).toBe(true)
      expect(byName('Search').state?.editable).toBe(true)
      expect('editable' in (byName('Heading').state ?? {})).toBe(false)
      expect('editable' in (byName('Locked').state ?? {})).toBe(false)
    })

    it('decodes numeric character references so a multi-line value keeps its newlines', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeTextView label="Body" value="Line one é&#10;Line two &#x2713; &amp;#10;" x="10" y="10" width="300" height="120" enabled="true" />
</AppiumAUT>`
      const { nodes } = parseMobileSource(xml, 'ios')
      expect(nodes[0].value).toBe('Line one é\nLine two ✓ &#10;')
    })
  })

  describe('Android editable signal', () => {
    it('never marks an Android node editable (the iOS lift only)', () => {
      const { nodes } = parseMobileSource(ANDROID_LOGIN_XML, 'android')
      const email = nodes.find(n => n.name === 'Email')!
      expect(email.nativeType).toBe('android.widget.EditText')
      for (const node of nodes) {
        expect('editable' in (node.state ?? {})).toBe(false)
      }
    })
  })

  describe('iOS accessible labelled Other', () => {
    const other = (attrs: string, children = '') =>
      children
        ? `<XCUIElementTypeOther ${attrs}>${children}</XCUIElementTypeOther>`
        : `<XCUIElementTypeOther ${attrs} />`

    it('emits the live Bluesky sheet rows as button nodes', () => {
      const { nodes } = parseMobileSource(IOS_SHEET_XML, 'ios', IOS_VIEWPORT)
      expect(nodes.map(n => n.name)).toEqual(['Mute account', 'Block account', 'Report account'])
      expect(nodes.map(n => n.role)).toEqual(['button', 'button', 'button'])
      const mute = nodes[0]
      expect(mute.bounds).toEqual({ x: 31, y: 715, width: 340, height: 43 })
      expect(mute.nativeType).toBe('XCUIElementTypeOther')
      expect(mute.attributes?.name).toBe('profileHeaderDropdownMuteBtn')
      expect(mute.attributes?.traits).toBe('')
    })

    it.each([
      ['Button', 'button'],
      ['Link', 'link'],
      ['Header', 'heading'],
      ['Image', 'image'],
      ['StaticText', 'text'],
      ['Selected, Button', 'button'],
      ['Button, Selected', 'button'],
      ['ToggleButton', 'button'],
      ['', 'button'],
      ['Adjustable', 'slider'],
      ['SearchField', 'searchbox'],
      ['TabBar', 'tablist'],
      ['UpdatesFrequently', 'text'],
      ['SummaryElement', 'text'],
      ['Button, Adjustable', 'slider'],
      ['Button, SearchField', 'searchbox'],
      ['Button, TabBar', 'tablist'],
      ['Unknown', 'button'],
    ])('maps traits "%s" to role %s', (traits, role) => {
      const xml = iosScreen(
        other(`label="Row" accessible="true" traits="${traits}" x="0" y="100" width="402" height="44"`),
      )
      const { nodes } = parseMobileSource(xml, 'ios', IOS_VIEWPORT)
      expect(nodes).toHaveLength(1)
      expect(nodes[0].role).toBe(role)
    })

    it('still lifts selected state on an emitted accessible Other', () => {
      const xml = iosScreen(
        other('label="Tab" accessible="true" selected="true" traits="Button, Selected" x="0" y="800" width="100" height="44"'),
      )
      const { nodes } = parseMobileSource(xml, 'ios', IOS_VIEWPORT)
      expect(nodes[0].state?.selected).toBe(true)
    })

    it('keeps unlabelled, non-accessible and boundless Others filtered', () => {
      const xml = iosScreen(
        [
          other('label="Not accessible" accessible="false" x="0" y="100" width="402" height="44"'),
          other('label="" name="someTestId" accessible="true" x="0" y="150" width="402" height="44"'),
          other('name="noLabel" accessible="true" x="0" y="200" width="402" height="44"'),
          other('label="No bounds" accessible="true"'),
        ].join('\n'),
      )
      expect(parseMobileSource(xml, 'ios', IOS_VIEWPORT).nodes).toEqual([])
      expect(parseMobileSource(xml, 'ios').nodes).toEqual([])
    })

    it('excludes a full-screen labelled Other with or without a viewport, but not a sheet', () => {
      const backdrop = iosScreen(
        other('label="Close" accessible="true" x="0" y="0" width="402" height="874"'),
      )
      expect(parseMobileSource(backdrop, 'ios', IOS_VIEWPORT).nodes).toEqual([])
      expect(parseMobileSource(backdrop, 'ios').nodes).toEqual([])

      const sheet = iosScreen(
        other('label="Sheet" accessible="true" x="0" y="474" width="402" height="400"'),
      )
      expect(parseMobileSource(sheet, 'ios', IOS_VIEWPORT).nodes.map(n => n.name)).toEqual(['Sheet'])
      expect(parseMobileSource(sheet, 'ios').nodes.map(n => n.name)).toEqual(['Sheet'])
    })

    it('keeps the descendant when it already carries the same label', () => {
      const wrapsText = iosScreen(
        other(
          'label="Settings" accessible="true" x="0" y="100" width="402" height="44"',
          '<XCUIElementTypeStaticText label="Settings" x="16" y="110" width="100" height="24" />',
        ),
      )
      const textNodes = parseMobileSource(wrapsText, 'ios', IOS_VIEWPORT).nodes
      expect(textNodes.map(n => [n.role, n.name])).toEqual([['text', 'Settings']])

      // WDA reports a descendant of an accessible Other as not accessible.
      const wrapsOther = iosScreen(
        other(
          'label="Row" accessible="true" x="0" y="100" width="402" height="60"',
          other('label="Row" accessible="false" x="8" y="104" width="380" height="52"'),
        ),
      )
      const rowNodes = parseMobileSource(wrapsOther, 'ios', IOS_VIEWPORT).nodes
      expect(rowNodes).toHaveLength(1)
      expect(rowNodes[0].name).toBe('Row')
      expect(rowNodes[0].bounds).toEqual({ x: 0, y: 100, width: 402, height: 60 })
    })

    it('does not promote tabs hidden behind a sheet, and still emits the sheet button', () => {
      const tab = (label: string, x: number, width: number) =>
        other(
          `visible="false" accessible="false" x="${x}" y="291" width="${width}" height="44"`,
          other(
            `label="${label}" enabled="true" visible="false" accessible="true" x="${x}" y="291" width="${width}" height="44" traits=""`,
          ),
        )
      const xml = iosScreen(
        [
          other(
            'visible="false" accessible="false" x="0" y="291" width="402" height="44"',
            [
              tab('Posts', 6, 91),
              tab('Replies', 97, 104),
              tab('Media', 200, 96),
              tab('Videos', 295, 101),
            ].join(''),
          ),
          other(
            'visible="true" accessible="false" x="0" y="474" width="402" height="400"',
            other(
              'label="Mute account" enabled="true" visible="true" accessible="true" x="31" y="715" width="340" height="43" traits=""',
            ),
          ),
        ].join('\n'),
      )
      const { nodes } = parseMobileSource(xml, 'ios', IOS_VIEWPORT)
      expect(nodes.map(n => [n.role, n.name])).toEqual([['button', 'Mute account']])
    })

    it.each([
      ['WDA broken frame', 'x="-1" y="-1" width="0" height="0"'],
      ['zero width', 'x="10" y="100" width="0" height="44"'],
      ['zero height', 'x="10" y="100" width="100" height="0"'],
    ])('does not promote an Other with a %s', (_name, frame) => {
      const xml = iosScreen(other(`label="Ghost" visible="true" accessible="true" ${frame}`))
      expect(parseMobileSource(xml, 'ios', IOS_VIEWPORT).nodes).toEqual([])
      expect(parseMobileSource(xml, 'ios').nodes).toEqual([])
    })

    it.each([
      ['below', 'x="0" y="900" width="402" height="44"'],
      ['above', 'x="0" y="-60" width="402" height="44"'],
      ['right of', 'x="410" y="100" width="100" height="44"'],
      ['left of', 'x="-120" y="100" width="100" height="44"'],
    ])('does not promote an Other with no visible attribute fully %s the screen', (_side, frame) => {
      const xml = iosScreen(other(`label="Away" accessible="true" ${frame}`))
      expect(parseMobileSource(xml, 'ios', IOS_VIEWPORT).nodes).toEqual([])
    })

    it('still promotes a visible Other that overlaps the screen edge', () => {
      const xml = iosScreen(
        [
          other('label="Partly below" accessible="true" x="0" y="850" width="402" height="44"'),
          other(
            'label="Visible" visible="true" accessible="true" x="0" y="100" width="402" height="44"',
          ),
        ].join('\n'),
      )
      expect(parseMobileSource(xml, 'ios', IOS_VIEWPORT).nodes.map(n => n.name)).toEqual([
        'Partly below',
        'Visible',
      ])
    })

    it('caps a promoted name at 120 characters', () => {
      const long = 'a'.repeat(300)
      const exact = 'b'.repeat(120)
      const xml = iosScreen(
        [
          other(`label="${long}" accessible="true" x="0" y="100" width="402" height="44"`),
          other(`label="${exact}" accessible="true" x="0" y="200" width="402" height="44"`),
          `<XCUIElementTypeStaticText label="${long}" x="0" y="300" width="402" height="44" />`,
        ].join('\n'),
      )
      const { nodes } = parseMobileSource(xml, 'ios', IOS_VIEWPORT)
      expect(nodes).toHaveLength(3)
      expect(nodes[0].name).toBe('a'.repeat(119) + '…')
      expect(nodes[0].name).toHaveLength(120)
      expect(nodes[1].name).toBe(exact)
      expect(nodes[2].role).toBe('text')
      expect(nodes[2].name).toBe(long)
    })

    it('emits both when the descendant label differs, parenting the descendant to the Other', () => {
      const xml = iosScreen(
        other(
          'label="Alice, 2h" accessible="true" x="0" y="100" width="402" height="60"',
          '<XCUIElementTypeStaticText label="Alice" x="16" y="110" width="100" height="24" />',
        ),
      )
      const { nodes } = parseMobileSource(xml, 'ios', IOS_VIEWPORT)
      expect(nodes.map(n => n.name)).toEqual(['Alice, 2h', 'Alice'])
      expect(nodes[1].parentIndex).toBe(0)
    })

    it('mints a ref whose entry resolves to the observed centre', () => {
      const { nodes } = parseMobileSource(IOS_SHEET_XML, 'ios', IOS_VIEWPORT)
      const { state, binding } = buildScreenState({
        platform: 'ios',
        nodes,
        viewport: IOS_VIEWPORT,
        scroll: deriveMobileScroll(nodes, IOS_VIEWPORT),
        coordSpace: 'viewport',
        timestamp: 0,
      })
      const entries = buildRefEntries(nodes, binding)
      const muteRef = state.elements.find(e => e.name === 'Mute account')!.ref
      expect(entries[muteRef].role).toBe('button')
      expect(entries[muteRef].nativeType).toBe('XCUIElementTypeOther')
      expect(entries[muteRef].bounds).toEqual({ x: 31, y: 715, width: 340, height: 43 })
      expect(new MobileElementResolver(entries).resolve(muteRef).center).toEqual({ x: 201, y: 736.5 })
    })

    it('leaves IOS_LOGIN_XML (a full-screen Other with no accessible attribute) at six nodes', () => {
      expect(parseMobileSource(IOS_LOGIN_XML, 'ios', { width: 390, height: 844 }).nodes).toHaveLength(6)
      expect(parseMobileSource(IOS_LOGIN_XML, 'ios').nodes).toHaveLength(6)
    })
  })

  describe('Android unchanged', () => {
    it('parses an accessible clickable ViewGroup row exactly as the base commit did', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <android.widget.FrameLayout bounds="[0,0][1080,2400]" resource-id="" content-desc="" text="" enabled="true">
    <android.view.ViewGroup bounds="[84,1920][996,2036]" resource-id="profileHeaderDropdownMuteBtn" content-desc="Mute account" text="" clickable="true" accessible="true" focusable="true" enabled="true" displayed="true">
      <android.widget.TextView bounds="[132,1950][460,2006]" resource-id="" content-desc="" text="Mute account" clickable="false" enabled="true" displayed="true" />
    </android.view.ViewGroup>
  </android.widget.FrameLayout>
</hierarchy>`
      const { nodes } = parseMobileSource(xml, 'android', { width: 1080, height: 2400 })
      // Captured from the unmodified parser at agent-qa 1eb37908f: the ViewGroup stays filtered.
      expect(nodes).toEqual([
        {
          role: 'text',
          name: 'Mute account',
          value: 'Mute account',
          bounds: { x: 132, y: 1950, width: 328, height: 56 },
          state: { enabled: true },
          attributes: {
            bounds: '[132,1950][460,2006]',
            'resource-id': '',
            'content-desc': '',
            text: 'Mute account',
            clickable: 'false',
            enabled: 'true',
            displayed: 'true',
          },
          nativeType: 'android.widget.TextView',
        },
      ])
      expect(JSON.stringify(nodes)).toBe(
        '[{"role":"text","name":"Mute account","value":"Mute account","bounds":{"x":132,"y":1950,"width":328,"height":56},"state":{"enabled":true},"attributes":{"bounds":"[132,1950][460,2006]","resource-id":"","content-desc":"","text":"Mute account","clickable":"false","enabled":"true","displayed":"true"},"nativeType":"android.widget.TextView"}]',
      )
    })
  })

  describe('Cross-platform normalization', () => {
    it('produces the same normalized roles for equivalent screens', () => {
      const android = parseMobileSource(ANDROID_LOGIN_XML, 'android')
      const ios = parseMobileSource(IOS_LOGIN_XML, 'ios')
      expect(android.nodes.map(n => n.role).sort()).toEqual(ios.nodes.map(n => n.role).sort())
    })

    it('produces the same labels for equivalent screens', () => {
      const android = parseMobileSource(ANDROID_LOGIN_XML, 'android')
      const ios = parseMobileSource(IOS_LOGIN_XML, 'ios')
      expect(android.nodes.map(n => n.name).sort()).toEqual(ios.nodes.map(n => n.name).sort())
    })
  })

  describe('bounds parsing', () => {
    it('parses Android bounds=[x1,y1][x2,y2] correctly', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.Button bounds="[0,100][500,200]" text="Test" enabled="true" />
</hierarchy>`
      const { nodes } = parseMobileSource(xml, 'android')
      expect(nodes[0].bounds).toEqual({ x: 0, y: 100, width: 500, height: 100 })
    })

    it('parses iOS x/y/width/height attributes correctly', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeButton label="Test" x="10" y="20" width="100" height="50" enabled="true" />
</AppiumAUT>`
      const { nodes } = parseMobileSource(xml, 'ios')
      expect(nodes[0].bounds).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    })
  })

  describe('enabled mapping', () => {
    it('lifts enabled=false onto state', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.Button bounds="[0,0][500,100]" text="Disabled" enabled="false" />
</hierarchy>`
      const { nodes } = parseMobileSource(xml, 'android')
      expect(nodes[0].state?.enabled).toBe(false)
    })
  })
})

const DUP_BUTTONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.LinearLayout bounds="[0,0][1080,1920]" text="" content-desc="" enabled="true">
    <android.widget.Button bounds="[0,0][500,100]" text="Submit" content-desc="" enabled="true" />
    <android.widget.Button bounds="[0,100][500,200]" text="Submit" content-desc="" enabled="true" />
    <android.widget.Button bounds="[0,200][500,300]" text="Cancel" content-desc="" enabled="true" />
  </android.widget.LinearLayout>
</hierarchy>`

describe('buildRefEntries (execute-time lastRefs reconstruction)', () => {
  it('reconstructs role/name/nth/bounds from nodes + the builder binding', () => {
    const { nodes } = parseMobileSource(ANDROID_LOGIN_XML, 'android', { width: 1080, height: 1920 })
    const { state, binding } = buildScreenState({
      platform: 'android',
      nodes,
      viewport: { width: 1080, height: 1920 },
      scroll: deriveMobileScroll(nodes, { width: 1080, height: 1920 }),
      coordSpace: 'viewport',
      timestamp: 0,
    })

    const entries = buildRefEntries(nodes, binding)

    // One entry per minted ref, keys aligned with the builder-minted refs.
    expect(Object.keys(entries).sort()).toEqual(Object.keys(binding).sort())

    // Resolve the Email textbox through its minted ref and check the `lastRefs` entry shape.
    const emailEl = state.elements.find(e => e.name === 'Email')!
    const emailEntry = entries[emailEl.ref]
    expect(emailEntry.role).toBe('textbox')
    expect(emailEntry.name).toBe('Email')
    expect(emailEntry).not.toHaveProperty('nth')
    expect(emailEntry).not.toHaveProperty('ordinal')
    expect(emailEntry.bounds).toEqual({ x: 100, y: 300, width: 880, height: 80 })
    expect(emailEntry.nativeType).toBe('android.widget.EditText')
  })

  it('carries the same-screen nth ordinal for duplicate role+name pairs', () => {
    const { nodes } = parseMobileSource(DUP_BUTTONS_XML, 'android')
    const { state, binding } = buildScreenState({
      platform: 'android',
      nodes,
      viewport: { width: 1080, height: 1920 },
      scroll: deriveMobileScroll(nodes, { width: 1080, height: 1920 }),
      coordSpace: 'viewport',
      timestamp: 0,
    })

    const entries = buildRefEntries(nodes, binding)
    const submitRefs = state.elements.filter(e => e.name === 'Submit').map(e => e.ref)
    expect(submitRefs).toHaveLength(2)
    // Duplicates differ by their node, never by a position.
    for (const ref of submitRefs) {
      expect(entries[ref]).toMatchObject({ role: 'button', name: 'Submit' })
      expect(entries[ref]).not.toHaveProperty('nth')
    }
    expect(entries[submitRefs[0]].bounds).toEqual({ x: 0, y: 0, width: 500, height: 100 })
    expect(entries[submitRefs[1]].bounds).toEqual({ x: 0, y: 100, width: 500, height: 100 })

    const cancelRef = state.elements.find(e => e.name === 'Cancel')!.ref
    expect(entries[cancelRef]).not.toHaveProperty('nth')
  })

  it('carries editable onto iOS editable entries only', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeTextView label="Body" x="10" y="10" width="300" height="120" enabled="true" />
  <XCUIElementTypeStaticText label="Heading" x="10" y="140" width="300" height="30" enabled="true" />
</AppiumAUT>`
    const { nodes } = parseMobileSource(xml, 'ios')
    const { state, binding } = buildScreenState({
      platform: 'ios',
      nodes,
      viewport: { width: 390, height: 844 },
      scroll: deriveMobileScroll(nodes, { width: 390, height: 844 }),
      coordSpace: 'viewport',
      timestamp: 0,
    })

    const entries = buildRefEntries(nodes, binding)
    const bodyRef = state.elements.find(e => e.name === 'Body')!.ref
    const headingRef = state.elements.find(e => e.name === 'Heading')!.ref
    expect(entries[bodyRef].editable).toBe(true)
    expect('editable' in entries[headingRef]).toBe(false)
    expect(state.elements.find(e => e.name === 'Body')!.state.editable).toBe(true)

    const android = parseMobileSource(ANDROID_LOGIN_XML, 'android')
    const androidBuilt = buildScreenState({
      platform: 'android',
      nodes: android.nodes,
      viewport: { width: 1080, height: 1920 },
      scroll: deriveMobileScroll(android.nodes, { width: 1080, height: 1920 }),
      coordSpace: 'viewport',
      timestamp: 0,
    })
    for (const entry of Object.values(buildRefEntries(android.nodes, androidBuilt.binding))) {
      expect('editable' in entry).toBe(false)
    }
  })
})

describe('deriveMobileScroll (best-effort approximation)', () => {
  it('returns max element extent as content size and zero offsets', () => {
    const { nodes } = parseMobileSource(ANDROID_LOGIN_XML, 'android', { width: 1080, height: 1920 })
    const scroll = deriveMobileScroll(nodes, { width: 1080, height: 1920 })
    // Tallest element bottom is the ImageView at y=700 h=200 → 900; viewport is taller.
    expect(scroll.offsetX).toBe(0)
    expect(scroll.offsetY).toBe(0)
    expect(scroll.contentWidth).toBe(1080)
    expect(scroll.contentHeight).toBe(1920)
  })

  it('grows content size past the viewport when bounds extend beyond it', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.Button bounds="[0,0][500,100]" text="Top" enabled="true" />
  <android.widget.Button bounds="[0,2500][500,2600]" text="Deep" enabled="true" />
</hierarchy>`
    const { nodes } = parseMobileSource(xml, 'android', { width: 1080, height: 1920 })
    const scroll = deriveMobileScroll(nodes, { width: 1080, height: 1920 })
    expect(scroll.contentHeight).toBe(2600)
  })

  it('falls back to the viewport dimensions when no node carries bounds', () => {
    const scroll = deriveMobileScroll([{ role: 'text', name: 'x' }], { width: 390, height: 844 })
    expect(scroll).toEqual({ offsetX: 0, offsetY: 0, contentWidth: 390, contentHeight: 844 })
  })
})

describe('buildScreenState integration (typed-absence survives the builder)', () => {
  it('derives documented state defaults and preserves real signals from the walk', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.CheckBox bounds="[0,0][100,100]" text="Agree" content-desc="Accept" resource-id="agree" checkable="true" checked="true" enabled="true" />
</hierarchy>`
    const { nodes } = parseMobileSource(xml, 'android', { width: 1080, height: 1920 })
    const { state } = buildScreenState({
      platform: 'android',
      nodes,
      viewport: { width: 1080, height: 1920 },
      scroll: deriveMobileScroll(nodes, { width: 1080, height: 1920 }),
      coordSpace: 'viewport',
      timestamp: 0,
    })

    const cb = state.elements[0]
    // Real signal preserved through the builder.
    expect(cb.state.checked).toBe(true)
    expect(cb.state.enabled).toBe(true)
    // Never-supplied signals: builder defaults, and selected stays typed-absent.
    expect(cb.state.focused).toBe(false)
    expect(cb.state.visible).toBe(true)
    expect('selected' in cb.state).toBe(false)
    // resource-id/content-desc rode through to schema labels.
    expect(cb.labels.testId).toBe('agree')
    expect(cb.labels.ariaLabel).toBe('Accept')
  })
})

function iosPage(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication name="Settings" label="Settings" x="0" y="0" width="402" height="874">
    <XCUIElementTypeWindow x="0" y="0" width="402" height="874">
${inner}
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`
}

function androidPage(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
${inner}
</hierarchy>`
}

function onlyNode(xml: string, platform: 'android' | 'ios') {
  const { nodes } = parseMobileSource(xml, platform)
  expect(nodes).toHaveLength(1)
  return nodes[0]
}

describe('toggle state parsing', () => {
  describe('Android', () => {
    it('an ordinary Button with selected="true" checkable="false" checked="false" lifts selected, no checked, and is not a toggle', () => {
      const node = onlyNode(
        androidPage(
          '  <android.widget.Button bounds="[0,400][1280,560]" text="Network &amp; internet" selected="true" checkable="false" checked="false" enabled="true" />',
        ),
        'android',
      )
      expect(node.state?.selected).toBe(true)
      expect('checked' in (node.state ?? {})).toBe(false)
      expect(isToggleElement(node)).toBe(false)
    })

    it('CheckBox, ToggleButton, Chip and CheckedTextView with checkable="true" checked="true" lift checked true and are toggles', () => {
      const cases: { tag: string; role: string }[] = [
        { tag: 'android.widget.CheckBox', role: 'checkbox' },
        { tag: 'android.widget.ToggleButton', role: 'button' },
        { tag: 'com.google.android.material.chip.Chip', role: 'button' },
        { tag: 'android.widget.CheckedTextView', role: 'text' },
      ]
      for (const { tag, role } of cases) {
        const node = onlyNode(
          androidPage(
            `  <${tag} bounds="[0,0][400,120]" text="Bold" checkable="true" checked="true" selected="false" enabled="true" />`,
          ),
          'android',
        )
        expect(node.role).toBe(role)
        expect(node.state?.checked).toBe(true)
        expect(isToggleElement(node)).toBe(true)
      }
    })

    it('a Switch with checked="false" and no checkable attribute gets no checked key', () => {
      const node = onlyNode(
        androidPage(
          '  <android.widget.Switch bounds="[1000,420][1200,540]" content-desc="Dark theme" checked="false" enabled="true" />',
        ),
        'android',
      )
      expect(node.role).toBe('switch')
      expect('checked' in (node.state ?? {})).toBe(false)
    })
  })

  describe('iOS', () => {
    function iosSwitchLike(tag: string, value: string | undefined, extra = ''): string {
      const valueAttr = value === undefined ? '' : ` value="${value}"`
      return iosPage(
        `      <${tag} name="REDUCE_MOTION" label="Reduce Motion"${valueAttr}${extra} x="16" y="200" width="370" height="52" enabled="true" visible="true" />`,
      )
    }

    it('XCUIElementTypeSwitch value="1" lifts checked true', () => {
      const node = onlyNode(iosSwitchLike('XCUIElementTypeSwitch', '1'), 'ios')
      expect(node.role).toBe('switch')
      expect(node.state?.checked).toBe(true)
      expect(isToggleElement(node)).toBe(true)
    })

    it('XCUIElementTypeSwitch value="0" lifts checked false', () => {
      const node = onlyNode(iosSwitchLike('XCUIElementTypeSwitch', '0'), 'ios')
      expect(node.state?.checked).toBe(false)
    })

    it('XCUIElementTypeSwitch value="" or value="On" or no value leaves checked absent', () => {
      for (const value of ['', 'On', undefined]) {
        const node = onlyNode(iosSwitchLike('XCUIElementTypeSwitch', value), 'ios')
        expect(node.role).toBe('switch')
        expect('checked' in (node.state ?? {})).toBe(false)
      }
    })

    it('XCUIElementTypeToggle value="1" lifts checked true', () => {
      const node = onlyNode(iosSwitchLike('XCUIElementTypeToggle', '1'), 'ios')
      expect(node.role).toBe('switch')
      expect(node.state?.checked).toBe(true)
    })

    it('XCUIElementTypeCheckBox value="0" lifts checked false', () => {
      const node = onlyNode(iosSwitchLike('XCUIElementTypeCheckBox', '0'), 'ios')
      expect(node.role).toBe('checkbox')
      expect(node.state?.checked).toBe(false)
    })

    it('XCUIElementTypeButton selected="true" value="1" lifts selected, no checked, and is not a toggle', () => {
      const node = onlyNode(iosSwitchLike('XCUIElementTypeButton', '1', ' selected="true"'), 'ios')
      expect(node.role).toBe('button')
      expect(node.state?.selected).toBe(true)
      expect('checked' in (node.state ?? {})).toBe(false)
      expect(isToggleElement(node)).toBe(false)
    })

    const SETTINGS_SWITCH_ROW = iosPage(`      <XCUIElementTypeCell x="0" y="300" width="402" height="52" enabled="true" visible="true">
        <XCUIElementTypeSwitch type="XCUIElementTypeSwitch" value="0" name="PREFER_NONBLINKING_CURSOR" label="Prefer Non-Blinking Cursor" enabled="true" visible="true" accessible="true" x="20" y="300" width="330" height="52" traits="ToggleButton, StaticText, Button">
          <XCUIElementTypeSwitch type="XCUIElementTypeSwitch" value="0" enabled="true" visible="true" accessible="false" x="303" y="311" width="63" height="29" traits="ToggleButton, Button" />
        </XCUIElementTypeSwitch>
      </XCUIElementTypeCell>`)

    it('the labelled outer switch and its unlabelled inner knob both parse as switches with checked false', () => {
      const { nodes } = parseMobileSource(SETTINGS_SWITCH_ROW, 'ios')
      const switches = nodes.filter((n) => n.nativeType === 'XCUIElementTypeSwitch')
      expect(switches).toHaveLength(2)
      const [outer, inner] = switches
      expect(outer.name).toBe('Prefer Non-Blinking Cursor')
      expect(inner.bounds).toEqual({ x: 303, y: 311, width: 63, height: 29 })
      expect(inner.parentIndex).toBe(nodes.indexOf(outer))
      for (const sw of switches) {
        expect(sw.role).toBe('switch')
        expect(sw.state?.checked).toBe(false)
      }
    })

    it('screenIdentityHash of a parsed iOS switch screen is the same with or without lifted checked', () => {
      const viewport = { width: 402, height: 874 }
      const { nodes } = parseMobileSource(SETTINGS_SWITCH_ROW, 'ios', viewport)
      const { state } = buildScreenState({
        platform: 'ios',
        nodes,
        viewport,
        scroll: deriveMobileScroll(nodes, viewport),
        coordSpace: 'viewport',
        timestamp: 0,
      })
      expect(state.elements.filter((el) => el.state.checked === false)).toHaveLength(2)

      const stripped = JSON.parse(JSON.stringify(state)) as ScreenState
      for (const el of stripped.elements) delete el.state.checked
      expect(stripped.elements.some((el) => 'checked' in el.state)).toBe(false)
      expect(screenIdentityHash(stripped)).toBe(screenIdentityHash(state))
    })
  })
})

describe('normalizeRole', () => {
  it('maps known Android types', () => {
    expect(normalizeRole('android.widget.Button', 'android')).toBe('button')
    expect(normalizeRole('android.widget.EditText', 'android')).toBe('textbox')
    expect(normalizeRole('android.widget.TextView', 'android')).toBe('text')
    expect(normalizeRole('android.widget.CheckBox', 'android')).toBe('checkbox')
  })

  it('maps known iOS types', () => {
    expect(normalizeRole('XCUIElementTypeButton', 'ios')).toBe('button')
    expect(normalizeRole('XCUIElementTypeTextField', 'ios')).toBe('textbox')
    expect(normalizeRole('XCUIElementTypeStaticText', 'ios')).toBe('text')
    expect(normalizeRole('XCUIElementTypeSwitch', 'ios')).toBe('switch')
  })

  it('falls back to stripped lowercase for unknown Android types', () => {
    expect(normalizeRole('android.widget.CustomView', 'android')).toBe('customview')
    expect(normalizeRole('com.google.android.material.chip.Chip', 'android')).toBe('button')
  })

  it('falls back to stripped lowercase for unknown iOS types', () => {
    expect(normalizeRole('XCUIElementTypePageIndicator', 'ios')).toBe('pageindicator')
  })

  it('handles fully unknown types gracefully', () => {
    expect(normalizeRole('SomeRandomType', 'android')).toBe('somerandomtype')
    expect(normalizeRole('SomeRandomType', 'ios')).toBe('somerandomtype')
  })

  it('returns element for empty type', () => {
    expect(normalizeRole('', 'android')).toBe('element')
    expect(normalizeRole('', 'ios')).toBe('element')
  })

  it('has comprehensive Android role map', () => {
    expect(Object.keys(ANDROID_ROLE_MAP).length).toBeGreaterThanOrEqual(15)
  })

  it('has comprehensive iOS role map', () => {
    expect(Object.keys(IOS_ROLE_MAP).length).toBeGreaterThanOrEqual(15)
  })
})

// The keyboard path learns a field's kind from the node's raw input type.
describe('the Android input type', () => {
  function entryFor(attr: string) {
    const xml = androidPage(
      `  <android.widget.EditText bounds="[0,0][800,120]" content-desc="Field" text="" enabled="true"${attr} />`,
    )
    const { nodes } = parseMobileSource(xml, 'android')
    const { state, binding } = buildScreenState({
      platform: 'android',
      nodes,
      viewport: { width: 1080, height: 1920 },
      scroll: deriveMobileScroll(nodes, { width: 1080, height: 1920 }),
      coordSpace: 'viewport',
      timestamp: 0,
    })
    return buildRefEntries(nodes, binding)[state.elements.find((e) => e.name === 'Field')!.ref]
  }

  it('an EditText with input-type="1048577" carries inputType 1048577', () => {
    expect(entryFor(' input-type="1048577"').inputType).toBe(1048577)
  })

  it('the text class with the multi-line flag (131073) carries 131073', () => {
    expect(entryFor(' input-type="131073"').inputType).toBe(131073)
  })

  it('input-type="0" carries 0', () => {
    expect(entryFor(' input-type="0"').inputType).toBe(0)
  })

  it.each([
    ['no attribute', ''],
    ['a non-integer', ' input-type="text"'],
    ['a negative number', ' input-type="-1"'],
    ['a decimal', ' input-type="1.5"'],
    ['an empty value', ' input-type=""'],
  ])('a node with %s carries no inputType', (_label, attr) => {
    expect('inputType' in entryFor(attr)).toBe(false)
  })
})
