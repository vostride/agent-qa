// The dashboard says what is true; each cell fails on copy that does not.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TARGET_ENVIRONMENT_CHOICE_LABELS, TARGET_ENVIRONMENT_PLACEHOLDER } from '@/lib/config-copy'
import * as feedbackView from '@/lib/feedback-view'
import { BUCKET_MEANINGS, OPEN_QUESTION_NOTE, PROPOSED_NOTE } from '@/lib/knowledge-view'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('copy that describes the no-review model', () => {
  it('a proposed record says it is recorded and not applied, and nothing says review', () => {
    for (const sentence of [BUCKET_MEANINGS.proposed, PROPOSED_NOTE, OPEN_QUESTION_NOTE]) {
      expect(sentence, sentence).not.toMatch(/review/i)
    }
    expect(BUCKET_MEANINGS.proposed).toMatch(/not applied/)
    expect(PROPOSED_NOTE).toMatch(/not applied/)
    expect(OPEN_QUESTION_NOTE).toMatch(/recorded/)
  })

  it('the no-class choice has one name', () => {
    expect(TARGET_ENVIRONMENT_PLACEHOLDER).toBe(TARGET_ENVIRONMENT_CHOICE_LABELS.undeclared)
  })

  it('a historical drafted mark reads as an older mark', () => {
    expect(feedbackView.DISPOSITION_TEXT.drafted).toBe('Recorded — a fix was drafted (older mark)')
  })

  it('the run-feedback hook imports no unused place helper', () => {
    const source = readFileSync(join(SRC, 'hooks', 'use-run-feedback.ts'), 'utf8')
    expect(source).not.toMatch(/\bplaceText\b/)
  })
})
