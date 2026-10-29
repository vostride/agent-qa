// Procedure-by-reference, the authoring half.
//
// This file owns the half that is a property of what the compile prompt renders and of what ends
// up on the shelf: a served procedure reaches the model as its own ANCHOR VOCABULARY and as
// nothing else, so the record's ADDRESS is never in front of a model that is writing a file this
// project will keep. The other half — that a step written in those words actually reaches the
// procedure at run time — is a property of `matchProcedure`, which lives in `knowledge-local` and
// cannot be imported here (`packages/agent` declares `runner`, `safety`, `schema`, `ai` and `zod`;
// an edge to `knowledge-local` is a `validate:arch` violation with no legal repair). Its cells are
// the sibling file of the same name in that package's serving suite.
//
// THE MUTATION THIS FILE MUST GO RED ON: rendering the served procedure's `id` into the prompt —
// the one-token edit that turns a semantic reference into a citation the model can paste. Every
// cell below is written so that edit reds something: the prompt cells by naming the id directly,
// and the shelf cell by scanning the bytes that were actually written.

import { asRecordId } from '@vostride/agent-qa-schema'
import type {
  AuthoringBrief,
  DraftReceipt,
  ProcedureMatch,
  ScopeKey,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { ACCEPT_CONTROL_DRAFT, fakeRunPort } from './evidence-fixtures.js'
import type { JobModelRequest } from '../../jobs/record-llm-authorship.js'
import { PROCEDURE_BY_REFERENCE_INSTRUCTION, knowledgeBlockBody } from '../brief-blocks.js'
import { AUTHORING_REFINE_AGENT_CONTEXT } from '../refine.js'
import { runAuthoringLoop } from '../loop.js'
import type {
  AuthoringReadPortLike,
  DraftShelfPortLike,
  SuiteTextCorpusEntryLike,
} from '../ports.js'

const SCOPE: ScopeKey = { tier: 'product', key: 'local-form' }
const INTENT = 'Check that a signed-in visitor sees the dashboard'

/** The learned-shelf address that must not reach an authored file. */
const RECORD_ID = 'proc-sign-in-with-a-saved-account'

const SERVED_PROCEDURE: ProcedureMatch = {
  id: asRecordId(RECORD_ID),
  flowAnchor: { t: 'flow', name: 'Sign in with a saved account' },
  confidence: 0.82,
  authoringModelTier: 'full',
  parameterSchema: [{ name: 'email', type: 'string', required: true }],
  replayRecommendation: 'replay',
}

const BRIEF_WITH_PROCEDURE: AuthoringBrief = {
  exemplars: [],
  procedures: [SERVED_PROCEDURE],
  facts: [],
  cautions: [],
  coverage: {},
  truncation: 'none',
  admissions: [],
}

describe('a served procedure reaches the model as vocabulary, never as an address', () => {
  it('renders the flow anchor own words in the knowledge block', () => {
    const body = knowledgeBlockBody(BRIEF_WITH_PROCEDURE)

    expect(body).toContain('PROCEDURE: Sign in with a saved account')
  })

  it('renders NO record id, and that is structural rather than filtered', () => {
    const body = knowledgeBlockBody(BRIEF_WITH_PROCEDURE)

    // Both directions of the same fact: the address is absent, and the vocabulary that replaced it
    // is present — so a renderer that emitted an empty procedure line would fail the cell above
    // rather than passing this one for free.
    expect(body).not.toContain(RECORD_ID)
    expect(body).toContain('Sign in with a saved account')
  })

  it('asks for prose and forbids a citation, in words the model reads', () => {
    // The syntactic half of D-17. A vocabulary rendered without this instruction would leave the
    // model free to invent `procedure:` syntax around the words it was given, which is precisely
    // the literal form D-17 diverges from.
    expect(PROCEDURE_BY_REFERENCE_INSTRUCTION).toContain('ordinary')
    expect(PROCEDURE_BY_REFERENCE_INSTRUCTION.toLowerCase()).toContain('do not cite a record')
    expect(PROCEDURE_BY_REFERENCE_INSTRUCTION.toLowerCase()).toContain('matches no listed flow')
  })
})

/** Both stage-3 calls, and the bytes that reached the shelf, captured from one real invocation. */
async function driveCompile() {
  const prompts: JobModelRequest[] = []
  const written: string[] = []

  const read: AuthoringReadPortLike = {
    // the `target` vocabulary. This file's claim is about PROCEDURE vocabulary,
    // so the list is present and minimal.
    configuredTargetNames: () => Promise.resolve(['local-form']),
    getAuthoringBrief: () => Promise.resolve(BRIEF_WITH_PROCEDURE),
    suiteTextCorpus: (): Promise<readonly SuiteTextCorpusEntryLike[]> => Promise.resolve([]),
  }

  const shelf: DraftShelfPortLike = {
    model: () => Promise.resolve({
      modelId: 'fixture:procedure-anchor',
      generate(request) {
        prompts.push(request)
        return Promise.resolve({
          text: (request.system ?? '').includes(AUTHORING_REFINE_AGENT_CONTEXT)
            // A zero-patch refinement: this file is about what the model was SHOWN, and a round
            // that mutated the document would put a second author between the prompt and the bytes.
            ? JSON.stringify({ thoughts: 'nothing new', patches: [] })
            : 'name: Sign in with a saved account\nsteps:\n  - Sign in with a saved account\n',
        })
      },
    }),
    write(contents: string) {
      written.push(contents)
      return Promise.resolve({ kind: 'staged' as const, draft: ACCEPT_CONTROL_DRAFT })
    },
    applyPatches: () => Promise.reject(new Error('a zero-patch round never reaches the applier')),
    runs: fakeRunPort({ runs: [] }),
    verifyDraft: (): Promise<DraftReceipt> => Promise.reject(new Error('verify is out of scope here')),
    publish: () => Promise.reject(new Error('nothing is verified here, so nothing is written')),
  }

  await runAuthoringLoop({ intent: INTENT, scope: SCOPE }, { read, shelf })
    .catch(() => undefined)

  return { prompts, written }
}

describe('the bytes that reach the shelf carry no learned-shelf record id', () => {
  it('shows both stage-3 calls the vocabulary and neither of them the address', async () => {
    const driven = await driveCompile()

    // BOTH calls. The compile prompt and the refinement prompt read the same knowledge block, so a
    // leak fixed in one and not the other would still put the address in front of a model that is
    // editing the file.
    expect(driven.prompts.length).toBeGreaterThanOrEqual(2)
    for (const request of driven.prompts) {
      expect(`${request.system}\n${request.prompt}`).not.toContain(RECORD_ID)
    }
    expect(driven.prompts[0]?.prompt).toContain('Sign in with a saved account')
    expect(driven.prompts[0]?.system).toContain(PROCEDURE_BY_REFERENCE_INSTRUCTION)
  })

  it('writes bytes that contain no record identifier', async () => {
    const driven = await driveCompile()

    // The claim scanned where it MATTERS — the bytes handed to the shelf, which are the bytes a
    // person later reads in their repository. Reading it off the prompt alone would prove the
    // model was not shown an id; reading it here proves nothing put one in the file.
    expect(driven.written).toHaveLength(1)
    expect(driven.written[0]).not.toContain(RECORD_ID)
    expect(driven.written[0]).toContain('Sign in with a saved account')
  })
})
