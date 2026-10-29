import { readFile } from 'node:fs/promises'
import { parseAllDocuments, LineCounter } from 'yaml'
import { TestDefinitionSchema } from '../schema/test-schema.js'
import type { TestDefinition } from '../types/test.js'
import { formatYamlError, formatZodErrors } from './errors.js'
import type { ParseError } from './errors.js'
import { findBareVariables } from '@vostride/agent-qa-runner'

export interface ParseResult {
  tests: TestDefinition[]
  errors: ParseError[]
}

/**
 * One parsed test paired with the exact source that produced it. ABRF-02 stable identity is
 * `filePath + test.name`; the legacy flattened parse result cannot retain that association and
 * caused multi-file direct runs to stamp every member with the first discovered file.
 */
export interface ParsedTestBinding {
  test: TestDefinition
  filePath: string
  fileContent: string
}

export interface ParseAllTestBindingsResult {
  bindings: ParsedTestBinding[]
  errors: ParseError[]
}

export function parseTestFile(
  content: string,
  filePath: string,
): ParseResult {
  const lineCounter = new LineCounter()
  const docs = parseAllDocuments(content, {
    lineCounter,
    prettyErrors: true,
    strict: true,
    keepSourceTokens: true,
  })

  const tests: TestDefinition[] = []
  const errors: ParseError[] = []

  for (const doc of docs) {
    // Skip empty documents (trailing --- or empty sections)
    if (doc.contents === null || doc.contents === undefined) continue

    // YAML-level syntax errors
    if (doc.errors.length > 0) {
      for (const err of doc.errors) {
        const pos = err.pos?.[0]
        const linePos =
          pos !== undefined ? lineCounter.linePos(pos) : undefined
        errors.push(formatYamlError(err, linePos, content, filePath))
      }
      continue
    }

    // Convert AST to plain JS object
    const value = doc.toJS()

    // Schema-level validation via Zod
    const parsed = TestDefinitionSchema.safeParse(value)
    if (!parsed.success) {
      errors.push(
        ...formatZodErrors(parsed.error, doc as unknown as Parameters<typeof formatZodErrors>[1], lineCounter, content, filePath),
      )
    } else {
      const bareErrors = checkBareVariables(parsed.data, filePath)
      if (bareErrors.length > 0) {
        errors.push(...bareErrors)
      } else {
        tests.push(parsed.data)
      }
    }
  }

  return { tests, errors }
}

function checkBareVariables(test: TestDefinition, filePath: string): ParseError[] {
  const errors: ParseError[] = []
  const textsToCheck: string[] = []

  if ((test as any).url) textsToCheck.push((test as any).url)
  for (const step of test.steps) {
    if (typeof step === 'string') {
      textsToCheck.push(step)
    } else {
      textsToCheck.push(step.step)
    }
  }

  for (const text of textsToCheck) {
    for (const varName of findBareVariables(text)) {
      errors.push({
        file: filePath,
        line: 1,
        column: 1,
        message: `Variable "{{${varName}}}" must use a namespace prefix: {{env:${varName}}}`,
        severity: 'error',
        source: text,
      })
    }
  }

  return errors
}

export async function parseAllTestBindings(
  filePaths: string[],
): Promise<ParseAllTestBindingsResult> {
  const bindings: ParsedTestBinding[] = []
  const allErrors: ParseError[] = []

  for (const filePath of filePaths) {
    const content = await readFile(filePath, 'utf-8')
    const result = parseTestFile(content, filePath)
    bindings.push(
      ...result.tests.map((test) => ({ test, filePath, fileContent: content })),
    )
    allErrors.push(...result.errors)
  }

  return { bindings, errors: allErrors }
}

export async function parseAllTests(
  filePaths: string[],
): Promise<ParseResult> {
  const { bindings, errors } = await parseAllTestBindings(filePaths)
  return { tests: bindings.map(({ test }) => test), errors }
}
