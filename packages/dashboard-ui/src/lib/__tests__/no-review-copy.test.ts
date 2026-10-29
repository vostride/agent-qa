// The dashboard says what is true (quick 261003-cpv: 432-UI-REVIEW priority fix 1 and pillar items,
// 432 review IN-31). Each cell reds on the copy the review quoted.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TARGET_ENVIRONMENT_CHOICE_LABELS, TARGET_ENVIRONMENT_PLACEHOLDER } from '@/lib/config-copy'
import * as feedbackView from '@/lib/feedback-view'
import { BUCKET_MEANINGS, OPEN_QUESTION_NOTE, PROPOSED_NOTE } from '@/lib/knowledge-view'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('C261003-CPV-UI-TRUTH: copy that describes the no-review model', () => {
  it('C261003-CPV-UI-TRUTH: a proposed record says it is recorded and not applied, and nothing says review', () => {
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

  it('C261003-CPV-UI-TRUTH: a historical drafted mark reads as an older mark', () => {
    expect(feedbackView.DISPOSITION_TEXT.drafted).toBe('Recorded — a fix was drafted (older mark)')
  })

  it('C261003-CPV-UI-TRUTH (IN-31): the run-feedback hook imports no unused place helper', () => {
    const source = readFileSync(join(SRC, 'hooks', 'use-run-feedback.ts'), 'utf8')
    expect(source).not.toMatch(/\bplaceText\b/)
  })
})
