import { describe, expect, it } from 'vitest'

import { pluginMaskName, RunSecretRedactor, SecretStore } from '../secrets.js'

const LONG = 'L0ng-Declared-Value-0123456789-abcdefghij'
const HANDED = 'tok/abc 123'

describe('a redactor that takes values handed over while it runs', () => {
  it('names a plugin entry PLUGIN_ and its name upper-cased with other characters as _', () => {
    expect(pluginMaskName('lab')).toBe('PLUGIN_LAB')
    expect(pluginMaskName('browser-stack.eu')).toBe('PLUGIN_BROWSER_STACK_EU')
  })

  it('masks a value added after the mask was built, and keeps masking values added before', () => {
    const redactor = new RunSecretRedactor(new SecretStore([['LONG', LONG]]))
    expect(redactor.redactString(`one ${HANDED}`)).toBe(`one ${HANDED}`)

    redactor.addMaskExtras([['PLUGIN_LAB', HANDED]])
    expect(redactor.redactString(`one ${HANDED}`)).toBe('one [secret:PLUGIN_LAB]')

    redactor.addMaskExtras([['PLUGIN_FARM', 'farm-key-42']])
    expect(redactor.redactString(`${LONG} ${HANDED} farm-key-42`)).toBe(
      '[secret:LONG] [secret:PLUGIN_LAB] [secret:PLUGIN_FARM]',
    )
    expect(redactor.redactValue({ url: `ws://h/?t=${encodeURIComponent(HANDED)}` })).toEqual({
      url: 'ws://h/?t=[secret:PLUGIN_LAB]',
    })
  })

  it('keeps the declared name for a handed-over value that is also a declared secret', () => {
    const redactor = new RunSecretRedactor(new SecretStore([['LONG', LONG]]))
    redactor.addMaskExtras([['PLUGIN_LAB', LONG]])
    expect(redactor.redactString(LONG)).toBe('[secret:LONG]')
  })

  it('ignores an empty value', () => {
    const redactor = new RunSecretRedactor(new SecretStore([]))
    redactor.addMaskExtras([['PLUGIN_LAB', '']])
    expect(redactor.redactString('nothing to hide')).toBe('nothing to hide')
  })
})
