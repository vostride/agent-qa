import { describe, expect, it } from 'vitest'

import { MCP_HTTP_DEFAULT_PORT, httpPort } from '../commands/mcp.js'

describe('agent-qa mcp --http port', () => {
  it('binds the default port when --http has no value', () => {
    expect(httpPort(true)).toBe(MCP_HTTP_DEFAULT_PORT)
  })

  it('binds the decimal port it is given, with 0 meaning any free port', () => {
    expect(httpPort('0')).toBe(0)
    expect(httpPort('4000')).toBe(4000)
    expect(httpPort('65535')).toBe(65535)
  })

  it.each(['0x1f90', '0abc', '-0', '-1', '65536', '99999', '1e3', '+80', '80.0', ' 80', '80 ', ''])(
    'refuses %j rather than binding some other port',
    (value) => {
      expect(() => httpPort(value)).toThrow(
        `--http expects a decimal port between 0 and 65535, received ${value}`,
      )
    },
  )
})
