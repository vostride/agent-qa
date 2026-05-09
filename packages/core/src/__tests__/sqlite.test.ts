import { describe, expect, it } from 'vitest'
import {
  isBetterSqlite3AbiMismatch,
  isBetterSqlite3NativeModuleError,
  isBetterSqlite3NodeGypSymlinkConflict,
  resolveBetterSqliteRebuildCommand,
} from '../sqlite.js'

describe('isBetterSqlite3AbiMismatch', () => {
  it('returns true for ABI mismatch errors', () => {
    const error = new Error(`The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127.`)
    expect(isBetterSqlite3AbiMismatch(error)).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isBetterSqlite3AbiMismatch(new Error('Cannot find module better-sqlite3'))).toBe(false)
  })
})

describe('isBetterSqlite3NativeModuleError', () => {
  it('returns true for missing bindings errors', () => {
    const error = new Error('Could not locate the bindings file. Tried:\n -> /tmp/better_sqlite3.node')
    expect(isBetterSqlite3NativeModuleError(error)).toBe(true)
  })

  it('returns true for missing bindings errors with node-v137 binding paths', () => {
    const error = new Error(
      'Could not locate the bindings file. Tried:\n' +
      ' -> /tmp/sqlite3/lib/binding/node-v137-darwin-arm64/better_sqlite3.node',
    )
    expect(isBetterSqlite3NativeModuleError(error)).toBe(true)
  })

  it('returns true for dlopen missing file errors after a stale partial build', () => {
    const error = new Error(
      'dlopen(/tmp/build/Release/better_sqlite3.node, 0x0001): tried: ' +
      "'/tmp/build/Release/better_sqlite3.node' (no such file)",
    )
    expect(isBetterSqlite3NativeModuleError(error)).toBe(true)
  })

  it('returns true for ABI mismatch errors', () => {
    const error = new Error(`The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127.`)
    expect(isBetterSqlite3NativeModuleError(error)).toBe(true)
  })

  it('returns false for unrelated missing module errors', () => {
    expect(isBetterSqlite3NativeModuleError(new Error('Cannot find module better-sqlite3'))).toBe(false)
  })
})

describe('isBetterSqlite3NodeGypSymlinkConflict', () => {
  it('returns true for node-gyp python symlink conflicts during rebuild', () => {
    const error = new Error("gyp ERR! stack Error: EEXIST: file already exists, symlink '/opt/homebrew/bin/python3' -> '/tmp/better-sqlite3/build/node_gyp_bins/python3'")
    expect(isBetterSqlite3NodeGypSymlinkConflict(error)).toBe(true)
  })

  it('returns false for unrelated rebuild failures', () => {
    expect(isBetterSqlite3NodeGypSymlinkConflict(new Error('gyp ERR! build error'))).toBe(false)
  })
})

describe('resolveBetterSqliteRebuildCommand', () => {
  it('runs the installed package build script in place with the active Node runtime', () => {
    const command = resolveBetterSqliteRebuildCommand()
    expect(command.command).toBeTypeOf('string')
    expect(command.command.length).toBeGreaterThan(0)
    expect(command.args.slice(-2)).toEqual(['run', 'build-release'])
  })
})
