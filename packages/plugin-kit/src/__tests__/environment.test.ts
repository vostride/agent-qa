import { describe, expect, it } from 'vitest'
import { pluginEnvironment } from '../protocol/index.js'

describe('the plugin environment', () => {
  it('passes only the allowed names, every LC_ name, and never NODE_OPTIONS', () => {
    const env = pluginEnvironment(
      {
        PATH: '/bin',
        HOME: '/home/a',
        LC_ALL: 'C',
        https_proxy: 'http://proxy:1',
        NODE_OPTIONS: '--require ./steal.js',
        AWS_SECRET_ACCESS_KEY: 'secret',
        SystemRoot: 'C:\\Windows',
      },
      'darwin',
    )

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/a',
      LC_ALL: 'C',
      https_proxy: 'http://proxy:1',
    })
  })

  it('adds the Windows system names on Windows, matching names without case', () => {
    const env = pluginEnvironment(
      { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\a', node_options: '-r x' },
      'win32',
    )

    expect(env).toEqual({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\a' })
  })
})
