import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseTestFile } from '../yaml-parser.js'
import { formatParseError } from '../errors.js'

const fixturesDir = resolve(__dirname, 'fixtures')

function readFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), 'utf-8')
}

describe('parseTestFile', () => {
  describe('valid single test', () => {
    it('parses valid-test.yaml into 1 TestDefinition with correct structure', () => {
      const content = readFixture('valid-test.yaml')
      const result = parseTestFile(content, 'valid-test.yaml')

      expect(result.errors).toHaveLength(0)
      expect(result.tests).toHaveLength(1)

      const test = result.tests[0]
      expect(test.name).toBe('Login with valid credentials')
      expect(test.target).toBe('my-app')
      expect(test.meta?.timeout).toBe(60000) // '1m' -> 60000ms
      expect(test.steps).toHaveLength(5)
      expect(test.steps.every((s: unknown) => typeof s === 'string')).toBe(true)
    })
  })

  describe('multi-document', () => {
    it('parses multi-test.yaml into 2 TestDefinition objects', () => {
      const content = readFixture('multi-test.yaml')
      const result = parseTestFile(content, 'multi-test.yaml')

      expect(result.errors).toHaveLength(0)
      expect(result.tests).toHaveLength(2)
      expect(result.tests[0].name).toBe('Add item to cart')
      expect(result.tests[1].name).toBe('Remove item from cart')
    })
  })

  describe('hybrid steps', () => {
    it('parses structured-steps.yaml with both string and object steps', () => {
      const content = readFixture('structured-steps.yaml')
      const result = parseTestFile(content, 'structured-steps.yaml')

      expect(result.errors).toHaveLength(0)
      expect(result.tests).toHaveLength(1)

      const steps = result.tests[0].steps
      expect(steps).toHaveLength(8)

      // Plain string steps
      expect(steps[0]).toBe('Navigate to the products page')
      expect(steps[1]).toBe('Click "Add to Cart" on the first product')

      // Structured step with timeout ('15s' -> 15000ms via Zod transform)
      expect(steps[2]).toEqual({
        step: 'Wait for the cart to update',
        timeout: 15000,
      })

      // Structured step with retries and screenshot
      expect(steps[6]).toEqual({
        step: 'Complete the checkout',
        retries: 3,
        screenshot: true,
      })
    })
  })

  describe('hook reference in step', () => {
    it('preserves ${hooks:...} syntax as-is', () => {
      const content = readFixture('structured-steps.yaml')
      const result = parseTestFile(content, 'structured-steps.yaml')

      expect(result.tests[0].steps[3]).toBe('${hooks:Prepare Payment}')
    })
  })

  describe('file reference in step', () => {
    it('preserves ${file:...} syntax as-is', () => {
      const content = readFixture('structured-steps.yaml')
      const result = parseTestFile(content, 'structured-steps.yaml')

      expect(result.tests[0].steps[4]).toBe(
        'Upload ${file:receipt.pdf} to the receipt field',
      )
    })
  })

  describe('variable reference in step', () => {
    it('preserves {{env:variable}} syntax as-is', () => {
      const content = readFixture('structured-steps.yaml')
      const result = parseTestFile(content, 'structured-steps.yaml')

      expect(result.tests[0].steps[5]).toBe(
        'Save the order number as {{env:orderNumber}}',
      )
      expect(result.tests[0].steps[7]).toBe(
        'Verify confirmation shows order {{env:orderNumber}}',
      )
    })
  })

  describe('YAML syntax error', () => {
    it('returns errors with line and column numbers for malformed YAML', () => {
      const content = readFixture('malformed-syntax.yaml')
      const result = parseTestFile(content, 'malformed-syntax.yaml')

      expect(result.errors.length).toBeGreaterThan(0)

      for (const error of result.errors) {
        expect(error.line).toBeGreaterThan(0)
        expect(error.column).toBeGreaterThan(0)
        expect(error.file).toBe('malformed-syntax.yaml')
        expect(error.severity).toBe('error')
      }
    })
  })

  describe('schema validation error', () => {
    it('returns errors for missing required fields and wrong types', () => {
      const content = readFixture('malformed-schema.yaml')
      const result = parseTestFile(content, 'malformed-schema.yaml')

      expect(result.tests).toHaveLength(0)
      expect(result.errors.length).toBeGreaterThan(0)

      // Should mention missing 'name' field
      const messages = result.errors.map((e) => e.message.toLowerCase())
      const mentionsRequired = messages.some(
        (m) => m.includes('required') || m.includes('name'),
      )
      expect(mentionsRequired).toBe(true)

      // Errors should have line/column positions
      for (const error of result.errors) {
        expect(error.line).toBeGreaterThan(0)
        expect(error.column).toBeGreaterThan(0)
        expect(error.file).toBe('malformed-schema.yaml')
      }
    })
  })

  describe('error format', () => {
    it('produces Rust-style formatted output with -->, |, and ^', () => {
      const content = readFixture('malformed-schema.yaml')
      const result = parseTestFile(content, 'malformed-schema.yaml')

      expect(result.errors.length).toBeGreaterThan(0)

      const formatted = formatParseError(result.errors[0], { noColor: true })
      expect(formatted).toContain('-->')
      expect(formatted).toContain('|')
      expect(formatted).toContain('^')
    })
  })

  describe('empty steps array', () => {
    it('rejects a test with steps: []', () => {
      const content = `name: Empty test\ntarget: test-app\nsteps: []\n`
      const result = parseTestFile(content, 'empty-steps.yaml')

      expect(result.tests).toHaveLength(0)
      expect(result.errors.length).toBeGreaterThan(0)
    })
  })

  describe('meta retries config', () => {
    it('parses retries from meta', () => {
      const content = readFixture('structured-steps.yaml')
      const result = parseTestFile(content, 'structured-steps.yaml')

      expect(result.tests).toHaveLength(1)
      const meta = result.tests[0].meta
      expect(meta?.retries).toBe(5)
    })
  })
})
