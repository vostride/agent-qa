// A refusal is a plain reason, and the CLI appends no flag, confirm, approval or trust command.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { ClauseReceipt } from '@vostride/agent-qa-schema'

import * as receiptLineModule from '../commands/receipt-line.js'
import { receiptLine } from '../commands/receipt-line.js'

const COMMANDS = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands')

/** Anything a reader could take as an instruction to approve, trust, answer or opt in. */
const SUGGESTED_ACTION = /--trust-session|\[y\/N\]|\bapprove\b|\bgrant\b|answer the confirm|opt in for this session|agent-qa \w+ --/i

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, (_m, kept?: string) => kept ?? '')
}

describe('the CLI has no remedy renderer', () => {
  it('receipt-line exports the receipt render and nothing that renders a remedy', () => {
    expect(Object.keys(receiptLineModule).sort()).toEqual(['receiptLine'])
  })

  it('no command source spells the remedy vocabulary or its renderer', () => {
    for (const file of ['receipt-line.ts', 'run.ts', 'fn.ts']) {
      const code = stripComments(readFileSync(join(COMMANDS, file), 'utf8'))
      for (const needle of ['denialDetailLines', 'remediesRenderable' + 'By', 'Gate' + 'Remedy', 'FunctionDenied' + 'Error', '.remedies']) {
        expect(code.includes(needle), `${file}: ${needle}`).toBe(false)
      }
    }
  })
})

describe('a refused run prints a plain reason and suggests nothing', () => {
  it('a refused or failed receipt renders its own outcome and appends no suggested command', () => {
    const base: Omit<ClauseReceipt, 'status' | 'outcome'> = {
      clause: 'start a run on prod',
      functionId: 'runs.start',
      origin: 'human',
    }
    for (const receipt of [
      { ...base, status: 'refused', outcome: 'RunIdAlreadyInUseError' },
      { ...base, status: 'failed', outcome: 'FunctionInputError' },
    ] satisfies ClauseReceipt[]) {
      const line = receiptLine(receipt)
      expect(line.split('\n')).toHaveLength(2)
      expect(line).toContain(receipt.outcome)
      expect(line).not.toMatch(SUGGESTED_ACTION)
    }
  })
})
