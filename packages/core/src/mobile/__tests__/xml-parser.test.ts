import { describe, it, expect } from 'vitest'
import { parseMobileSource } from '../xml-parser.js'
import { normalizeRole, ANDROID_ROLE_MAP, IOS_ROLE_MAP } from '../role-map.js'

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

describe('parseMobileSource', () => {
  describe('Android XML parsing', () => {
    it('parses login screen with correct roles and labels', () => {
      const result = parseMobileSource(ANDROID_LOGIN_XML, 'android')

      const roles = result.elements.map(e => e.role)
      expect(roles).toContain('text')
      expect(roles).toContain('textbox')
      expect(roles).toContain('button')
      expect(roles).toContain('image')

      const names = result.elements.map(e => e.name)
      expect(names).toContain('Welcome Back')
      expect(names).toContain('Email')
      expect(names).toContain('Password')
      expect(names).toContain('Sign In')
      expect(names).toContain('Sign Up')
      expect(names).toContain('App Logo')
    })

    it('assigns sequential refs starting at e1', () => {
      const result = parseMobileSource(ANDROID_LOGIN_XML, 'android')

      const refs = result.elements.map(e => e.ref)
      expect(refs[0]).toBe('e1')
      expect(refs[refs.length - 1]).toBe(`e${refs.length}`)

      // Verify refs are sequential
      for (let i = 0; i < refs.length; i++) {
        expect(refs[i]).toBe(`e${i + 1}`)
      }
    })

    it('parses Android bounds correctly', () => {
      const result = parseMobileSource(ANDROID_LOGIN_XML, 'android')

      // First textbox (Email): bounds="[100,300][980,380]"
      const emailRef = result.elements.find(e => e.name === 'Email')!
      const emailBounds = result.refs[emailRef.ref].bounds
      expect(emailBounds).toEqual({ x: 100, y: 300, width: 880, height: 80 })
    })

    it('preserves native metadata for Android spinner controls', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.Spinner bounds="[10,20][300,80]" text="Priority" content-desc="" enabled="true" />
</hierarchy>`

      const result = parseMobileSource(xml, 'android')
      const spinner = result.elements[0]

      expect(spinner.role).toBe('combobox')
      expect(spinner.name).toBe('Priority')
      expect(spinner.value).toBe('Priority')
      expect(spinner.attributes.nativeType).toBe('android.widget.Spinner')
      expect(spinner.attributes.value).toBe('Priority')
      expect(result.refs[spinner.ref]).toMatchObject({
        role: 'combobox',
        nativeType: 'android.widget.Spinner',
        value: 'Priority',
      })
    })

    it('builds tree string with ARIA snapshot format', () => {
      const result = parseMobileSource(ANDROID_LOGIN_XML, 'android')

      expect(result.tree).toContain('- text "Welcome Back" [ref=')
      expect(result.tree).toContain('- textbox "Email" [ref=')
      expect(result.tree).toContain('- button "Sign In" [ref=')
    })
  })

  describe('iOS XML parsing', () => {
    it('parses login screen with correct roles and labels', () => {
      const result = parseMobileSource(IOS_LOGIN_XML, 'ios')

      const roles = result.elements.map(e => e.role)
      expect(roles).toContain('text')
      expect(roles).toContain('textbox')
      expect(roles).toContain('button')
      expect(roles).toContain('image')

      const names = result.elements.map(e => e.name)
      expect(names).toContain('Welcome Back')
      expect(names).toContain('Email')
      expect(names).toContain('Password')
      expect(names).toContain('Sign In')
      expect(names).toContain('Sign Up')
      expect(names).toContain('App Logo')
    })

    it('parses iOS bounds from individual attributes', () => {
      const result = parseMobileSource(IOS_LOGIN_XML, 'ios')

      const emailRef = result.elements.find(e => e.name === 'Email')!
      const emailBounds = result.refs[emailRef.ref].bounds
      expect(emailBounds).toEqual({ x: 20, y: 150, width: 350, height: 40 })
    })

    it('assigns sequential refs to iOS elements', () => {
      const result = parseMobileSource(IOS_LOGIN_XML, 'ios')

      expect(result.elements.length).toBeGreaterThan(0)
      for (let i = 0; i < result.elements.length; i++) {
        expect(result.elements[i].ref).toBe(`e${i + 1}`)
      }
    })

    it('preserves native metadata for iOS picker wheel controls', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypePickerWheel value="March" x="20" y="300" width="350" height="80" enabled="true" />
</AppiumAUT>`

      const result = parseMobileSource(xml, 'ios')
      const picker = result.elements[0]

      expect(['pickerwheel', 'spinbutton']).toContain(picker.role)
      expect(picker.name).toBe('March')
      expect(picker.value).toBe('March')
      expect(picker.attributes.nativeType).toBe('XCUIElementTypePickerWheel')
      expect(result.refs[picker.ref]).toMatchObject({
        nativeType: 'XCUIElementTypePickerWheel',
        value: 'March',
      })
    })
  })

  describe('Cross-platform normalization', () => {
    it('produces the same normalized roles for equivalent screens', () => {
      const android = parseMobileSource(ANDROID_LOGIN_XML, 'android')
      const ios = parseMobileSource(IOS_LOGIN_XML, 'ios')

      const androidRoles = android.elements.map(e => e.role).sort()
      const iosRoles = ios.elements.map(e => e.role).sort()

      expect(androidRoles).toEqual(iosRoles)
    })

    it('produces the same labels for equivalent screens', () => {
      const android = parseMobileSource(ANDROID_LOGIN_XML, 'android')
      const ios = parseMobileSource(IOS_LOGIN_XML, 'ios')

      const androidNames = android.elements.map(e => e.name).sort()
      const iosNames = ios.elements.map(e => e.name).sort()

      expect(androidNames).toEqual(iosNames)
    })
  })

  describe('bounds parsing', () => {
    it('parses Android bounds=[x1,y1][x2,y2] correctly', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.Button bounds="[0,100][500,200]" text="Test" enabled="true" />
</hierarchy>`

      const result = parseMobileSource(xml, 'android')
      const bounds = result.refs[result.elements[0].ref].bounds
      expect(bounds).toEqual({ x: 0, y: 100, width: 500, height: 100 })
    })

    it('parses iOS x/y/width/height attributes correctly', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeButton label="Test" x="10" y="20" width="100" height="50" enabled="true" />
</AppiumAUT>`

      const result = parseMobileSource(xml, 'ios')
      const bounds = result.refs[result.elements[0].ref].bounds
      expect(bounds).toEqual({ x: 10, y: 20, width: 100, height: 50 })
    })
  })

  describe('nth disambiguation', () => {
    it('assigns nth to duplicate role+name pairs', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.LinearLayout bounds="[0,0][1080,1920]" text="" content-desc="" enabled="true">
    <android.widget.Button bounds="[0,0][500,100]" text="Submit" content-desc="" enabled="true" />
    <android.widget.Button bounds="[0,100][500,200]" text="Submit" content-desc="" enabled="true" />
    <android.widget.Button bounds="[0,200][500,300]" text="Cancel" content-desc="" enabled="true" />
  </android.widget.LinearLayout>
</hierarchy>`

      const result = parseMobileSource(xml, 'android')

      const submitButtons = result.elements.filter(e => e.name === 'Submit')
      expect(submitButtons).toHaveLength(2)
      expect(result.refs[submitButtons[0].ref].nth).toBe(0)
      expect(result.refs[submitButtons[1].ref].nth).toBe(1)

      const cancelButton = result.elements.find(e => e.name === 'Cancel')!
      expect(result.refs[cancelButton.ref].nth).toBeUndefined()
    })
  })

  describe('unlabeled container nodes', () => {
    it('includes container nodes in tree but does not assign refs', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.FrameLayout bounds="[0,0][1080,1920]" text="" content-desc="" enabled="true">
    <android.widget.Button bounds="[0,0][500,100]" text="Click Me" content-desc="" enabled="true" />
  </android.widget.FrameLayout>
</hierarchy>`

      const result = parseMobileSource(xml, 'android')

      // The group container should be in tree
      expect(result.tree).toContain('- group')
      // But only the button gets a ref
      expect(result.elements).toHaveLength(1)
      expect(result.elements[0].role).toBe('button')
    })
  })

  describe('bounds in tree text', () => {
    it('includes @(x,y WxH) bounds in Android tree text for ref elements', () => {
      const result = parseMobileSource(ANDROID_LOGIN_XML, 'android')

      // "Welcome Back" text: bounds="[100,200][980,280]" → x=100, y=200, w=880, h=80
      expect(result.tree).toContain('@(100,200 880x80)')
      // "Email" textbox: bounds="[100,300][980,380]" → x=100, y=300, w=880, h=80
      expect(result.tree).toContain('@(100,300 880x80)')
    })

    it('includes @(x,y WxH) bounds in iOS tree text for ref elements', () => {
      const result = parseMobileSource(IOS_LOGIN_XML, 'ios')

      // "Email" textbox: x=20, y=150, width=350, height=40
      expect(result.tree).toContain('@(20,150 350x40)')
      // "Sign In" button: x=20, y=260, width=350, height=44
      expect(result.tree).toContain('@(20,260 350x44)')
    })

    it('places bounds after [ref=eN] and before [disabled]/[offscreen]', () => {
      const result = parseMobileSource(ANDROID_LOGIN_XML, 'android')

      // Verify bounds appear after [ref=eN] in tree lines
      const lines = result.tree.split('\n')
      const refLines = lines.filter(l => l.includes('[ref='))
      for (const line of refLines) {
        const refIdx = line.indexOf('[ref=')
        const boundsIdx = line.indexOf('@(')
        expect(boundsIdx).toBeGreaterThan(refIdx)
      }
    })

    it('does not add bounds annotations to container nodes without refs', () => {
      const result = parseMobileSource(ANDROID_LOGIN_XML, 'android')

      const lines = result.tree.split('\n')
      const groupLines = lines.filter(l => l.includes('- group'))
      for (const line of groupLines) {
        expect(line).not.toContain('@(')
      }
    })
  })

  describe('disabled elements', () => {
    it('marks disabled elements in attributes', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <android.widget.Button bounds="[0,0][500,100]" text="Disabled" content-desc="" enabled="false" />
</hierarchy>`

      const result = parseMobileSource(xml, 'android')

      expect(result.elements[0].attributes['disabled']).toBe('true')
      expect(result.tree).toContain('[disabled]')
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
