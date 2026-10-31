import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  builtPackageSourceMapErrors,
  danglingSourceMapUrls,
} from '../validate-publish-surface.mjs'

function withDist(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-dist-'))
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), body)
    }
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a declaration that names a source map the build did not emit is reported', () => {
  withDist(
    {
      'index.d.ts': 'export declare const a: 1;\n//# sourceMappingURL=index.d.ts.map',
      'index.d.cts': 'export declare const a: 1;\n//# sourceMappingURL=index.d.cts.map\n',
      'server/index.d.ts': 'export {};\n//# sourceMappingURL=index.d.ts.map',
    },
    (dir) => {
      assert.deepEqual(
        danglingSourceMapUrls(dir).sort((a, b) => a.file.localeCompare(b.file)),
        [
          { file: 'index.d.cts', url: 'index.d.cts.map' },
          { file: 'index.d.ts', url: 'index.d.ts.map' },
          { file: join('server', 'index.d.ts'), url: 'index.d.ts.map' },
        ],
      )
    },
  )
})

test('source map URLs pass when the map sits beside the file, is inline or is absent', () => {
  withDist(
    {
      'index.js': 'export const a = 1;\n\n//# sourceMappingURL=index.js.map',
      'index.js.map': '{}',
      'index.cjs': 'exports.a = 1;\n//# sourceMappingURL=data:application/json;base64,e30=',
      'index.d.ts': 'export declare const a: 1;\n',
      'style.css': 'a{}\n/*# sourceMappingURL=style.css.map */',
      'style.css.map': '{}',
    },
    (dir) => assert.deepEqual(danglingSourceMapUrls(dir), []),
  )
})

test('a dangling source map URL fails the publish surface with the package and file named', () => {
  withDist({ 'dist/index.d.ts': 'export {};\n//# sourceMappingURL=index.d.ts.map' }, (dir) => {
    assert.deepEqual(builtPackageSourceMapErrors([{ dir, pkg: { name: '@vostride/agent-qa-fixture' } }]), [
      '@vostride/agent-qa-fixture dist/index.d.ts points at source map index.d.ts.map, which is not emitted',
    ])
  })
})

test('every built package ships only source map URLs whose maps it ships', () => {
  assert.deepEqual(builtPackageSourceMapErrors(), [])
})
