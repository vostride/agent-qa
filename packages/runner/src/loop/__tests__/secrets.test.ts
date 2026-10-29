import { describe, expect, it } from 'vitest'
import {
  SecretStore,
  SecretRedactor,
  MissingSecretError,
  findSecretTemplates,
  redactSecretValue,
  resolveSecretTemplatesInValue,
  containsRedactedSecretMarker,
  literalSecretMarkerRefusal,
} from '../secrets.js'

describe('findSecretTemplates', () => {
  it('extracts {{secret:*}} templates from text', () => {
    expect(findSecretTemplates('login with {{secret:password}} and {{secret:token}}')).toEqual([
      { pattern: '{{secret:password}}', name: 'password' },
      { pattern: '{{secret:token}}', name: 'token' },
    ])
  })
})

describe('redactSecretValue', () => {
  it('replaces secret values with the redaction marker in plans/results/error strings', () => {
    const store = new SecretStore({ password: 'hunter2' })
    const redactor = new SecretRedactor(store)
    const redacted = redactSecretValue(
      { note: 'entered hunter2', nested: ['hunter2'] },
      redactor,
    )
    expect(redacted).toEqual({ note: 'entered [secret:password]', nested: ['[secret:password]'] })
  })

  it('rewrites {{secret:name}} templates to [secret:name] markers', () => {
    const store = new SecretStore({ password: 'hunter2' })
    const redactor = new SecretRedactor(store)
    expect(redactSecretValue('fill {{secret:password}}', redactor)).toBe('fill [secret:password]')
  })

  it('returns the value unchanged when no redactor is given', () => {
    expect(redactSecretValue('hunter2', undefined)).toBe('hunter2')
  })

  it('keeps an own __proto__ key as data instead of setting the prototype', () => {
    const redactor = new SecretRedactor(new SecretStore({ password: 'hunter2' }))
    const redacted = redactSecretValue(Object.fromEntries([['__proto__', 'hunter2'], ['plain', 'x']]), redactor)
    expect(Object.keys(redacted)).toEqual(['__proto__', 'plain'])
    expect(Object.getOwnPropertyDescriptor(redacted, '__proto__')?.value).toBe('[secret:password]')
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype)
  })
})

describe('resolveSecretTemplatesInValue', () => {
  it('substitutes secret templates only when given a store', () => {
    const store = new SecretStore({ password: 'hunter2' })
    expect(resolveSecretTemplatesInValue({ value: 'fill {{secret:password}}' }, store)).toEqual({
      value: 'fill hunter2',
    })
    // Without a store, templates are left intact (resolved only at the execute boundary).
    expect(resolveSecretTemplatesInValue('fill {{secret:password}}', undefined)).toBe(
      'fill {{secret:password}}',
    )
  })
})

describe('containsRedactedSecretMarker', () => {
  it('returns true for a plan containing a redacted marker (cache-poisoning guard)', () => {
    expect(containsRedactedSecretMarker({ action: { type: 'fill', value: '[secret:password]' } })).toBe(true)
  })

  it('returns false for a plan with no redacted marker', () => {
    expect(containsRedactedSecretMarker({ action: { type: 'fill', value: 'plaintext' } })).toBe(false)
  })
})

// Rule 23 says `[secret:NAME]` is hidden and `{{secret:NAME}}` types it; one fixture checks both.
describe('prompt/mechanism round trip of the secret-fill contract', () => {
  const SECRET_NAME = 'loginPassword'
  const BOUND_VALUE = 'hunter2-correct-horse'
  const TEMPLATE = `{{secret:${SECRET_NAME}}}`
  const DISPLAY_MARKER = `[secret:${SECRET_NAME}]`

  const store = new SecretStore({ [SECRET_NAME]: BOUND_VALUE })
  const redactor = new SecretRedactor(store)

  const stepText = `Type ${TEMPLATE} into the password field`
  const plannedAction = { type: 'fill', ref: 'e12', value: TEMPLATE }

  it('half A — model-bound step text displays the template as the named marker', () => {
    // This is exactly what the planner sees, and what Rule 23 tells it to expect.
    expect(redactor.redactString(stepText)).toBe(
      `Type ${DISPLAY_MARKER} into the password field`,
    )
    expect(containsRedactedSecretMarker(redactor.redactString(stepText))).toBe(true)
  })

  it('half B — a planned action carrying the template form resolves at dispatch', () => {
    // Rule 23 instructs the model to emit the TEMPLATE form verbatim as the value.
    // The dispatch seam resolves it, so following the rule succeeds by construction.
    expect(resolveSecretTemplatesInValue(plannedAction, store)).toEqual({
      type: 'fill',
      ref: 'e12',
      value: BOUND_VALUE,
    })
  })

  it('negative — the bound value never appears in redacted model-bound text', () => {
    // Value masking runs on this fixture: teaching the mechanism must not widen disclosure.
    const leaked = `the field now contains ${BOUND_VALUE}`
    const redacted = redactor.redactString(leaked)
    expect(redacted).not.toContain(BOUND_VALUE)
    expect(redacted).toBe('the field now contains [secret:loginPassword]')

    // ...and the redacted step text never carries the value either.
    expect(redactor.redactString(stepText)).not.toContain(BOUND_VALUE)
  })

  it('failure — a template naming an unbound secret keeps its current semantics', () => {
    // Pins today's behavior (store.require throws MissingSecretError); no change.
    // loop/index.ts resolves INSIDE the try, so this surfaces as a redacted
    // execError and the action never reaches the adapter.
    expect(() =>
      resolveSecretTemplatesInValue({ value: '{{secret:neverBound}}' }, store),
    ).toThrow(MissingSecretError)
  })
})

describe('masking declared secret values', () => {
  const redactorFor = (content: string) => new SecretRedactor(SecretStore.fromEnvContent(content))

  it('a raw declared value becomes its named marker', () => {
    const redactor = new SecretRedactor(new SecretStore({ password: 'hunter2' }))
    expect(redactor.redactString('pw hunter2')).toBe('pw [secret:password]')
  })

  it('a one-character and a three-character value are masked', () => {
    const redactor = redactorFor('one=Z\nthree=q^7')
    expect(redactor.redactString('Zebra q^7 and Z again q^7')).toBe(
      '[secret:one]ebra [secret:three] and [secret:one] again [secret:three]',
    )
  })

  it('the longest value wins when one value holds another', () => {
    const redactor = redactorFor('short=cde\napi_key=abcdef')
    expect(redactor.redactString('xabcdefx')).toBe('x[secret:api_key]x')
    expect(redactor.redactString('cde')).toBe('[secret:short]')
  })

  it('masking twice changes nothing', () => {
    const redactor = redactorFor('api=api\napi_key=zzzz')
    const text = 'api zzzz {{secret:api_key}} [secret:api] apix'
    const once = redactor.redactString(text)
    expect(once).toBe('[secret:api] [secret:api_key] [secret:api_key] [secret:api] [secret:api]x')
    expect(redactor.redactString(once)).toBe(once)
    expect(once).toContain('[secret:api_key]')
  })

  it('touching values mask as two markers', () => {
    const redactor = redactorFor('a=AAA\nb=BBB')
    expect(redactor.redactString('AAABBB')).toBe('[secret:a][secret:b]')
  })

  it('two names sharing one value take the first-declared name', () => {
    const redactor = redactorFor('first=same\nsecond=same')
    for (let call = 0; call < 3; call += 1) {
      expect(redactor.redactString('the same value')).toBe('the [secret:first] value')
    }
    expect(redactorFor('b=same\n1=same').redactString('same')).toBe('[secret:b]')
  })

  it('an empty value is skipped and a whitespace-only value is masked', () => {
    expect(redactorFor('blank=').redactString('nothing to hide here')).toBe('nothing to hide here')
    expect(redactorFor('space=" "').redactString('a b')).toBe('a[secret:space]b')
  })

  it('an empty store still names templates and masks nothing else', () => {
    const redactor = new SecretRedactor(SecretStore.empty())
    expect(redactor.redactString('{{secret:x}} and q^7')).toBe('[secret:x] and q^7')
  })

  it('encoded and case-changed forms are not masked', () => {
    const redactor = new SecretRedactor(new SecretStore({ token: 'Ab/c d', accent: 'caf\u00e9' }))
    for (const text of ['ab/c d', 'Ab%2Fc%20d', 'Ab\\/c d', btoa('Ab/c d'), 'cafe\u0301']) {
      expect(redactor.redactString(text)).toBe(text)
    }
    expect(redactor.redactString('Ab/c d caf\u00e9')).toBe('[secret:token] [secret:accent]')
  })
})

describe('masking a declared value written as a marker or template name', () => {
  const redactor = () => new SecretRedactor(new SecretStore({ PW: 'hunter2' }))

  it('a declared value written as a marker or template name is masked', () => {
    const masked = redactor().redactString('page shows [secret:hunter2] and {{secret:hunter2}}')
    expect(masked).not.toContain('hunter2')
    expect(masked).toBe('page shows [secret:[secret:PW]] and [secret:[secret:PW]]')
  })

  it('a declared-name marker or template is unchanged in behaviour, and masking twice changes nothing', () => {
    const once = redactor().redactString(
      'keep [secret:PW], name {{secret:PW}}, hide [secret:hunter2] and {{secret:hunter2}}',
    )
    expect(once).toBe(
      'keep [secret:PW], name [secret:PW], hide [secret:[secret:PW]] and [secret:[secret:PW]]',
    )
    expect(redactor().redactString(once)).toBe(once)
  })
})

describe('literal secret markers that refuse dispatch', () => {
  it('only a bracketed secret name is a literal marker', () => {
    for (const text of ['[secret:]', '[secret:a-b]', '{{secret:A}}', 'plain text']) {
      expect(literalSecretMarkerRefusal(text)).toBeUndefined()
    }
  })

  it('the first marker in walk order names the refusal', () => {
    const action = {
      type: 'fill',
      target: { role: 'textbox', name: 'Email [secret:EMAIL]' },
      text: '[secret:PASSWORD]',
      extra: ['[secret:LATER]'],
    }
    expect(literalSecretMarkerRefusal(action)).toBe(
      'This action contains the masked placeholder [secret:EMAIL]; it would type the placeholder ' +
        'text. Use {{secret:EMAIL}} to type the secret.',
    )
    expect(literalSecretMarkerRefusal({ type: 'fill', text: '{{secret:EMAIL}}' })).toBeUndefined()
  })
})
