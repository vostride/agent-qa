// How init's package.json edit keeps the file's own format.
import { describe, expect, it } from 'vitest'

import { InitRefusal } from '../commands/init-refusal.js'
import { planPackageJson } from '../commands/package-json-plan.js'

const PATH = '/project/package.json'
const VERSION = '0.3.3'

function edit(text: string): string {
  return planPackageJson({
    path: PATH,
    text,
    folderName: 'project',
    dependencies: [{ name: 'agent-qa', version: VERSION }],
  }).content
}

function withoutLine(text: string, line: string): string {
  expect(text).toContain(line)
  return text.replace(line, '')
}

function refusal(text: string): unknown {
  try {
    edit(text)
  } catch (error) {
    return error
  }
  return undefined
}

describe('package.json edits keep the file format', () => {
  it('a two-space file gets the entry at two-space depth and every other byte is unchanged', () => {
    const before =
      '{\n  "name": "shop",\n  "devDependencies": {\n    "@types/node": "24.0.0",\n    "typescript": "6.0.0"\n  }\n}\n'

    const after = edit(before)

    expect(withoutLine(after, `    "agent-qa": "${VERSION}",\n`)).toBe(before)
  })

  it('a four-space file gets the entry at four-space depth and every other byte is unchanged', () => {
    const before =
      '{\n    "name": "shop",\n    "devDependencies": {\n        "@types/node": "24.0.0",\n        "typescript": "6.0.0"\n    }\n}\n'

    const after = edit(before)

    expect(withoutLine(after, `        "agent-qa": "${VERSION}",\n`)).toBe(before)
  })

  it('a tab-indented file gets the entry indented with tabs and every other byte is unchanged', () => {
    const before =
      '{\n\t"name": "shop",\n\t"devDependencies": {\n\t\t"@types/node": "24.0.0",\n\t\t"typescript": "6.0.0"\n\t}\n}\n'

    const after = edit(before)

    expect(withoutLine(after, `\t\t"agent-qa": "${VERSION}",\n`)).toBe(before)
  })

  it('a CRLF file stays CRLF', () => {
    const before =
      '{\r\n  "name": "shop",\r\n  "devDependencies": {\r\n    "typescript": "6.0.0"\r\n  }\r\n}\r\n'

    const after = edit(before)

    expect(withoutLine(after, `    "agent-qa": "${VERSION}",\r\n`)).toBe(before)
    expect(after.replace(/\r\n/gu, '')).not.toContain('\n')
  })

  it('a CRLF file without the block gets the block with CRLF line endings', () => {
    const before = '{\r\n  "name": "shop",\r\n  "private": true\r\n}\r\n'

    expect(edit(before)).toBe(
      `{\r\n  "name": "shop",\r\n  "private": true,\r\n  "devDependencies": {\r\n    "agent-qa": "${VERSION}"\r\n  }\r\n}\r\n`,
    )
  })

  it('a file without a final newline gets none', () => {
    const before = '{\n  "name": "shop",\n  "private": true\n}'

    expect(edit(before)).toBe(
      `{\n  "name": "shop",\n  "private": true,\n  "devDependencies": {\n    "agent-qa": "${VERSION}"\n  }\n}`,
    )
  })

  it('a file with a final newline keeps it', () => {
    const before = '{\n  "name": "shop",\n  "devDependencies": {\n    "typescript": "6.0.0"\n  }\n}\n'

    const after = edit(before)

    expect(after.endsWith('}\n')).toBe(true)
    expect(after.endsWith('}\n\n')).toBe(false)
  })

  it('a rewritten entry changes only its version', () => {
    const before =
      '{\n\t"name": "shop",\n\t"devDependencies": {\n\t\t"agent-qa": "^0.3.0",\n\t\t"typescript": "6.0.0"\n\t}\n}'

    const after = edit(before)

    expect(after).toBe(before.replace('"^0.3.0"', `"${VERSION}"`))
  })

  it('a new key goes in sorted position within the block', () => {
    const before =
      '{\n  "devDependencies": {\n    "@types/node": "24.0.0",\n    "vitest": "4.0.0",\n    "zod": "4.0.0"\n  }\n}\n'

    const keys = Object.keys(JSON.parse(edit(before)).devDependencies)

    expect(keys).toEqual(['@types/node', 'agent-qa', 'vitest', 'zod'])
  })

  it('a missing devDependencies block is appended after the existing keys', () => {
    const before =
      '{\n  "name": "shop",\n  "private": true,\n  "scripts": {\n    "test": "vitest"\n  }\n}\n'

    expect(edit(before)).toBe(
      `{\n  "name": "shop",\n  "private": true,\n  "scripts": {\n    "test": "vitest"\n  },\n  "devDependencies": {\n    "agent-qa": "${VERSION}"\n  }\n}\n`,
    )
  })

  it('a one-line file gets the entry and keeps every other key and value', () => {
    const before = '{"name":"shop","private":true,"scripts":{"test":"vitest"}}'

    const after = JSON.parse(edit(before))

    expect(after).toEqual({
      name: 'shop',
      private: true,
      scripts: { test: 'vitest' },
      devDependencies: { 'agent-qa': VERSION },
    })
    expect(Object.keys(after)).toEqual(['name', 'private', 'scripts', 'devDependencies'])
  })

  it('a file that is not valid JSON is refused with the parser message', () => {
    const text = '{ "name": "shop",'
    let parserMessage = ''
    try {
      JSON.parse(text)
    } catch (error) {
      parserMessage = (error as Error).message
    }

    const error = refusal(text)

    expect(error).toBeInstanceOf(InitRefusal)
    expect((error as Error).message).toBe(
      `Refusing to update ${PATH}: it is not valid JSON (${parserMessage}).`,
    )
  })

  it.each(['[]', '"x"'])('%s is refused as not a JSON object', (text) => {
    const error = refusal(text)

    expect(error).toBeInstanceOf(InitRefusal)
    expect((error as Error).message).toBe(
      `${PATH} must contain a JSON object to declare agent-qa.`,
    )
  })
})
