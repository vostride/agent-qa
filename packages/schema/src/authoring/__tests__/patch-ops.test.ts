// The refusal surface of the RFC-6902 edit vocabulary (394, D-20 · WTST-07).
//
// Every cell here is about what the schema REFUSES, because acceptance is the easy half: a model
// emitting `{op:'replace', path:'/steps/1', value:'…'}` is the happy path, and a model emitting
// `{op:'move', from:'/steps/1', path:'/steps/3'}` is the one that has to be stopped before the
// applier sees two pointers where the fence checks one.

import { describe, expect, it } from 'vitest'

import {
  EDITABLE_POINTER_ROOTS,
  PATCH_OP_KINDS,
  PatchOpSchema,
  TestEditPatchSetSchema,
  isEditablePointer,
  parseJsonPointer,
  pointerRootOf,
} from '../patch-ops'

describe('PatchOpSchema — the three admitted ops', () => {
  it('parses replace with a pointer and a value', () => {
    const parsed = PatchOpSchema.parse({
      op: 'replace',
      path: '/steps/1',
      value: 'Type "bob" into the Username field',
    })
    expect(parsed).toEqual({
      op: 'replace',
      path: '/steps/1',
      value: 'Type "bob" into the Username field',
    })
  })

  it('parses add against the append pointer', () => {
    const parsed = PatchOpSchema.parse({
      op: 'add',
      path: '/steps/-',
      value: 'Verify the Logout button is visible',
    })
    expect(parsed.op).toBe('add')
    expect(parsed.path).toBe('/steps/-')
  })

  it('parses remove, which carries no value', () => {
    const parsed = PatchOpSchema.parse({ op: 'remove', path: '/steps/2' })
    expect(parsed).toEqual({ op: 'remove', path: '/steps/2' })
    expect('value' in parsed).toBe(false)
  })

  it('refuses a value on remove — a removed node has nothing to write', () => {
    const result = PatchOpSchema.safeParse({
      op: 'remove',
      path: '/steps/2',
      value: 'anything',
    })
    expect(result.success).toBe(false)
  })
})

describe('PatchOpSchema — the ops that are NOT admitted', () => {
  it.each([
    ['move', { op: 'move', from: '/steps/1', path: '/steps/3' }],
    ['copy', { op: 'copy', from: '/steps/1', path: '/steps/3' }],
    ['test', { op: 'test', path: '/steps/1', value: 'Click the Submit button' }],
  ])('refuses %s by name — it is not in PATCH_OP_KINDS', (kind, op) => {
    const result = PatchOpSchema.safeParse(op)
    expect(result.success).toBe(false)
    expect(PATCH_OP_KINDS as readonly string[]).not.toContain(kind)
  })

  it('refuses an unknown key on an otherwise valid op (.strict())', () => {
    const result = PatchOpSchema.safeParse({
      op: 'replace',
      path: '/steps/1',
      value: 'Click the Submit button',
      from: '/steps/0',
    })
    expect(result.success).toBe(false)
  })

  it('refuses a non-string value — a patch never installs a nested collection', () => {
    const result = PatchOpSchema.safeParse({
      op: 'replace',
      path: '/steps/1',
      value: { step: 'Click the Submit button', timeout: '30s' },
    })
    expect(result.success).toBe(false)
  })
})

describe('PatchOpSchema — pointer shape', () => {
  it.each(['steps/1', 'steps', '#/steps/1', ' /steps/1'])(
    'refuses the malformed pointer %o',
    (path) => {
      const result = PatchOpSchema.safeParse({ op: 'remove', path })
      expect(result.success).toBe(false)
      expect(result.error?.issues.some((issue) => issue.path.includes('path'))).toBe(true)
    },
  )

  it('accepts the whole-document pointer as a SHAPE — the fence, not the schema, refuses it', () => {
    expect(PatchOpSchema.safeParse({ op: 'remove', path: '' }).success).toBe(true)
    expect(isEditablePointer('')).toBe(false)
  })
})

describe('TestEditPatchSetSchema — the {thoughts, patches} envelope', () => {
  it('parses a set with thoughts and one op', () => {
    const parsed = TestEditPatchSetSchema.parse({
      thoughts: 'The username step names the wrong field.',
      patches: [{ op: 'replace', path: '/steps/0', value: 'Type "bob" into the Username field' }],
    })
    expect(parsed.patches).toHaveLength(1)
  })

  it('accepts an empty patches array — a no-op set is an answer, not an error', () => {
    const parsed = TestEditPatchSetSchema.parse({ thoughts: 'Nothing to change.', patches: [] })
    expect(parsed.patches).toEqual([])
  })

  it('accepts empty thoughts but REFUSES the field being absent', () => {
    expect(TestEditPatchSetSchema.safeParse({ thoughts: '', patches: [] }).success).toBe(true)
    expect(TestEditPatchSetSchema.safeParse({ patches: [] }).success).toBe(false)
  })

  it('refuses an unknown envelope key (.strict())', () => {
    const result = TestEditPatchSetSchema.safeParse({
      thoughts: '',
      patches: [],
      reasoning: 'a second spelling of thoughts',
    })
    expect(result.success).toBe(false)
  })

  it('refuses a set whose ops are individually invalid', () => {
    const result = TestEditPatchSetSchema.safeParse({
      thoughts: '',
      patches: [
        { op: 'replace', path: '/steps/0', value: 'ok' },
        { op: 'move', from: '/steps/0', path: '/steps/1' },
      ],
    })
    expect(result.success).toBe(false)
  })
})

describe('the editable-region fence', () => {
  it('resolves the root of a pointer', () => {
    expect(pointerRootOf('/steps/1')).toBe('steps')
    expect(pointerRootOf('/name')).toBe('name')
    expect(pointerRootOf('')).toBeUndefined()
  })

  it('decodes RFC-6901 escapes, ~1 before ~0', () => {
    expect(parseJsonPointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d'])
    expect(parseJsonPointer('/~01')).toEqual(['~1'])
    expect(parseJsonPointer('')).toEqual([])
  })

  it('admits exactly the pinned roots and nothing else', () => {
    expect([...EDITABLE_POINTER_ROOTS]).toEqual(['steps', 'name', 'context'])
    for (const root of EDITABLE_POINTER_ROOTS) {
      expect(isEditablePointer(`/${root}`)).toBe(true)
    }
  })

  it.each(['/target', '/test-id', '/use/browser/headless', '/meta/timeout', '/setup/0', ''])(
    'refuses the identity pointer %o — a patch cannot retarget which app a test hits',
    (path) => {
      expect(isEditablePointer(path)).toBe(false)
    },
  )

  it('cannot be bypassed by escaping the root segment', () => {
    // `~1` decodes to `/`, so `/steps~1..~1target` is the single root token `steps/../target`
    // rather than a path through `steps` — the decoder resolves it before the membership test.
    expect(pointerRootOf('/steps~1..~1target')).toBe('steps/../target')
    expect(isEditablePointer('/steps~1..~1target')).toBe(false)
  })
})
