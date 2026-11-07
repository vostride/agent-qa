import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { isMap, isScalar, parseDocument } from 'yaml'
import { describe, expect, it } from 'vitest'

import {
  PNPM_DENIED_BUILDS,
  ignoredBuildNames,
  withDeniedBuilds,
} from '../commands/package-manager-settings.js'

function trueLines(text: string): string[] {
  return text.split(/\r?\n/u).filter((line) => /:\s*true\b/u.test(line))
}

function denied(src: string, names: readonly string[] = PNPM_DENIED_BUILDS): string {
  const result = withDeniedBuilds(src, names)
  if ('refused' in result) throw new Error(result.refused)
  expect(trueLines(result.text)).toEqual(trueLines(src))
  return result.text
}

describe('pnpm build scripts are denied in pnpm-workspace.yaml', () => {
  it('an empty file gains an allowBuilds block denying the four build scripts', () => {
    expect(denied('')).toBe(
      'allowBuilds:\n  edgedriver: false\n  geckodriver: false\n  onnxruntime-node: false\n  protobufjs: false\n',
    )
  })

  it('a file without allowBuilds keeps every byte and gains the block at its end', () => {
    const src = 'packages:\n  - "apps/*"   # apps\n  - packages/*\n# trailing comment'
    const out = denied(src)

    expect(out.startsWith(src)).toBe(true)
    expect(out).toBe(
      `${src}\nallowBuilds:\n  edgedriver: false\n  geckodriver: false\n  onnxruntime-node: false\n  protobufjs: false\n`,
    )
  })

  it('a block allowBuilds gains only the missing names, at its own indent, after its last item', () => {
    const src = [
      'packages:',
      '  - packages/*',
      'allowBuilds:',
      '    sharp: true  # needs its binary',
      '    edgedriver: false',
      'overrides:',
      '  glob: 14.0.3',
      '',
    ].join('\n')

    expect(denied(src)).toBe(
      [
        'packages:',
        '  - packages/*',
        'allowBuilds:',
        '    sharp: true  # needs its binary',
        '    edgedriver: false',
        '    geckodriver: false',
        '    onnxruntime-node: false',
        '    protobufjs: false',
        'overrides:',
        '  glob: 14.0.3',
        '',
      ].join('\n'),
    )
  })

  it('a block allowBuilds that already lists every name is left as it is', () => {
    const src =
      'allowBuilds:\n  edgedriver: true\n  geckodriver: false\n  onnxruntime-node: false\n  protobufjs: false\n'
    const result = withDeniedBuilds(src, PNPM_DENIED_BUILDS)

    expect(result).toEqual({ text: src, added: [] })
  })

  it('a flow allowBuilds is refused and names what to add', () => {
    const result = withDeniedBuilds('allowBuilds: { sharp: true }\n', ['edgedriver'])

    expect(result).toMatchObject({ refused: 'allowBuilds is not a block map' })
  })

  it('a file whose root is not a block map is refused', () => {
    expect(withDeniedBuilds('- a\n', ['edgedriver'])).toHaveProperty('refused')
    expect(withDeniedBuilds('{ packages: [a] }\n', ['edgedriver'])).toHaveProperty('refused')
    expect(withDeniedBuilds('a: [\n', ['edgedriver'])).toHaveProperty('refused')
  })

  it('a CRLF file gets CRLF on the inserted lines', () => {
    expect(denied('packages:\r\n  - a\r\n', ['esbuild'])).toBe(
      'packages:\r\n  - a\r\nallowBuilds:\r\n  esbuild: false\r\n',
    )
    expect(denied('allowBuilds:\r\n  sharp: true\r\n', ['esbuild'])).toBe(
      'allowBuilds:\r\n  sharp: true\r\n  esbuild: false\r\n',
    )
  })

  it('a block allowBuilds at the end of a file without a final newline gains its lines', () => {
    expect(denied('allowBuilds:\n  sharp: true', ['esbuild'])).toBe(
      'allowBuilds:\n  sharp: true\n  esbuild: false\n',
    )
  })

  it('a scoped name is quoted so the file stays valid YAML', () => {
    const out = denied('', ['@scope/x'])

    expect(out).toBe('allowBuilds:\n  "@scope/x": false\n')
    expect(parseDocument(out).toJS()).toEqual({ allowBuilds: { '@scope/x': false } })
  })

  it('pnpm lists the ignored build scripts by name, without their versions', () => {
    const output = [
      ' ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild@0.25.0, @scope/x@1.0.0',
      'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
    ].join('\n')

    expect(ignoredBuildNames(output)).toEqual(['esbuild', '@scope/x'])
    expect(ignoredBuildNames('nothing here')).toEqual([])
  })

  it("the deny list init writes is the false entries of agent-qa's own pnpm-workspace.yaml", () => {
    const path = fileURLToPath(new URL('../../../../pnpm-workspace.yaml', import.meta.url))
    const allowBuilds = parseDocument(readFileSync(path, 'utf8')).get('allowBuilds', true)
    expect(isMap(allowBuilds)).toBe(true)
    const deniedHere = isMap(allowBuilds)
      ? allowBuilds.items
          .filter((pair) => isScalar(pair.value) && pair.value.value === false)
          .map((pair) => String(isScalar(pair.key) ? pair.key.value : pair.key))
      : []

    expect([...PNPM_DENIED_BUILDS].sort()).toEqual(deniedHere.sort())
  })
})
