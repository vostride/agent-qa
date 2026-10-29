import { describe, it, expect } from 'vitest'
import { DashboardConfigSchema, ServicesSchema } from '../services-schema.js'

// `services.dashboard.baseUrl` is refused at the PARSE boundary unless it is an absolute http(s)
// URL.
//
// WHY THIS VALUE AND NOT EVERY STRING IN THE FILE. In M5 this one stops being a display string. It
// composes the tokenless live link (`liveRunLinkOf` only strips trailing slashes), and that link is
// assigned to an `href` inside the served App document — which runs with `allow-scripts` at an
// opaque origin — AND appended verbatim to every carrier tool result's model-readable text. Before
// the refinement, `baseUrl: 'javascript:alert(1)'` composed `javascript:alert(1)/runs/<id>/live`
// and reached both hops. The trust boundary is the operator, so this is not remote-triggerable; the
// finding is that a URL-shaped value reached an `href` with no scheme check at any hop.
//
// THE MESSAGE IS ASSERTED, not just the refusal. An operator who wrote a relative path needs to be
// told what the value must BE.

const MESSAGE = 'services.dashboard.baseUrl must be an absolute http(s) URL'

describe('DashboardConfigSchema.baseUrl, the parse-time hop', () => {
  it.each([
    ['an origin', 'http://127.0.0.1:7777'],
    ['an https origin with a path prefix', 'https://dash.internal/prefix'],
    ['a trailing-slash base — normalisation is the composer, not the schema', 'http://dash.internal/'],
  ])('accepts %s', (_label, baseUrl) => {
    const result = DashboardConfigSchema.safeParse({ baseUrl })
    expect(result.success, JSON.stringify(result.success ? {} : result.error.issues)).toBe(true)
    // The value is carried through UNCHANGED — the guard refuses, it never rewrites.
    expect(result.success && result.data.baseUrl).toBe(baseUrl)
  })

  it.each([
    // The finding itself: a scheme that EXECUTES when it reaches an href.
    ['a javascript: scheme', 'javascript:alert(1)'],
    // Parses as a URL, so only the scheme test refuses it.
    ['a mailto: address', 'mailto:qa@example.com'],
    // Does not parse without a base — resolving it here would invent a host.
    ['a relative path', '/relative/only'],
    ['a bare word', 'not-a-url'],
    // Stricter than before: "" is a value somebody wrote, not a key they left out.
    ['the empty string', ''],
    ['whitespace only', '   '],
  ])('refuses %s, and says what the value must be', (_label, baseUrl) => {
    const result = DashboardConfigSchema.safeParse({ baseUrl })
    expect(result.success).toBe(false)
    const issues = result.success ? [] : result.error.issues
    expect(issues.map((issue) => issue.path.join('.'))).toContain('baseUrl')
    expect(issues.map((issue) => issue.message)).toContain(MESSAGE)
  })

  it('leaves an ABSENT base absent — no dashboard configured is an honest posture', () => {
    const result = DashboardConfigSchema.safeParse({})
    expect(result.success).toBe(true)
    expect(result.success && result.data.baseUrl).toBeUndefined()
    expect(result.success && Object.hasOwn(result.data, 'baseUrl')).toBe(false)
  })

  it('reaches the same verdicts through the whole services block', () => {
    expect(ServicesSchema.safeParse({ dashboard: {} }).success).toBe(true)
    expect(ServicesSchema.safeParse({ dashboard: { baseUrl: 'http://127.0.0.1:7777' } }).success)
      .toBe(true)
    expect(ServicesSchema.safeParse({ dashboard: { baseUrl: 'javascript:alert(1)' } }).success)
      .toBe(false)
  })

  it('refuses a non-string base without the refinement swallowing the type error', () => {
    const result = DashboardConfigSchema.safeParse({ baseUrl: 7777 })
    expect(result.success).toBe(false)
  })
})
