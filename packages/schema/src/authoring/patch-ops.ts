// The RFC-6902 edit vocabulary for test documents (394, D-20 · WTST-07).
//
// THIS IS NOT THE UNIFIED-DIFF VOCABULARY. `packages/schema/src/patch/patch.ts` already carries
// a `Hunk { header, lines }` / `FileChange { path, changeKind, hunks }` representation, and D-06
// records deliberately that 394 does NOT reuse it. The two answer different questions: a hunk
// describes bytes a human reviews before applying, and the ops below describe positions in a
// PARSED document that a CST applier mutates so the untouched bytes never move. Unifying them
// would force one of the two to lie about what it addresses. Read both headers before merging.
//
// The envelope is `{ thoughts, patches }` because WTST-07 names that shape: the model's reasoning
// travels beside its edit rather than inside it, so nothing in `patches` has to be prose-parsed.

import { z } from 'zod'

/**
 * The admitted ops — three of RFC-6902's six.
 *
 * `move` and `copy` are absent because each is expressible as an `add` plus a `remove`, and
 * admitting them would double the pointer-resolution surface the editable-region fence has to
 * cover: every `move` carries TWO pointers, and a fence that passes the destination while the
 * source addresses an excluded root is exactly the retarget T-394-10 exists to stop. `test` is
 * absent because it asserts something about the document rather than changing it, and the
 * post-render `TestDefinitionSchema` check already owns "is this document still runnable".
 *
 * A closed three-member vocabulary is also what lets the applier's `switch` be exhaustive, so a
 * fourth member cannot be added without the compiler naming every site that must handle it.
 */
export const PATCH_OP_KINDS = ['add', 'remove', 'replace'] as const

export type PatchOpKind = (typeof PATCH_OP_KINDS)[number]

/**
 * A JSON Pointer (RFC-6901): the empty string, or a string beginning with `/`.
 *
 * The check is deliberately shape-only. Whether the pointer RESOLVES is a fact about a document,
 * which this package cannot see; whether it addresses a region a patch may touch is the fence
 * below. Refusing a malformed pointer here means the applier never has to guess whether `steps/1`
 * meant the root key `steps/1` or the path `/steps/1`.
 */
const JsonPointerSchema = z
  .string()
  .refine((value) => value === '' || value.startsWith('/'), {
    message: 'path must be a JSON Pointer: the empty string, or a string starting with "/"',
  })

/**
 * The value an `add` or `replace` writes: a string, always.
 *
 * D-02 splits creation away from editing — a whole document is emitted whole and schema-validated,
 * and only subsequent MUTATIONS are patches. A patch that installs a nested collection is a
 * document rewrite wearing an op's clothes: the CST applier can preserve untouched bytes only
 * because every write it performs is one scalar token, so admitting object values here would
 * publish a contract the byte-preservation proof does not cover. A structured step (a `{step,
 * timeout}` mapping) is still editable field-by-field — `/steps/1/step` is a scalar pointer.
 */
const PatchValueSchema = z.string()

/**
 * One RFC-6902 op, discriminated on `op`, every arm `.strict()`.
 *
 * `.strict()` is the refusal surface rather than a formality: these objects are authored by a
 * model and cross a trust boundary into a document that decides which app a test drives. An
 * unknown key is a signal the emitter is working from a different contract, and silently dropping
 * it would let that disagreement reach the applier.
 */
export const PatchOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    path: JsonPointerSchema,
    value: PatchValueSchema,
  }).strict(),
  z.object({
    op: z.literal('remove'),
    path: JsonPointerSchema,
  }).strict(),
  z.object({
    op: z.literal('replace'),
    path: JsonPointerSchema,
    value: PatchValueSchema,
  }).strict(),
])

export type PatchOp = z.infer<typeof PatchOpSchema>

/**
 * The `{ thoughts, patches }` envelope WTST-07 names.
 *
 * `thoughts` is REQUIRED and may be empty. A set without the field is a different contract, and
 * making it optional would let two emitters disagree about whether the field exists while both
 * validate. An empty `patches` array is ACCEPTED and means "nothing to change" — a no-op that
 * renders byte-identical output, never an error, because "the edit you asked for is already true"
 * is a legitimate answer for a repair loop to reach.
 */
export const TestEditPatchSetSchema = z.object({
  thoughts: z.string(),
  patches: z.array(PatchOpSchema),
}).strict()

export type TestEditPatchSet = z.infer<typeof TestEditPatchSetSchema>

/**
 * The document roots a patch may address.
 *
 * `steps` is what a test DOES; `name` and `context` are what it says about itself. Everything
 * else a test document carries — `test-id`, `target`, `use`, `meta`, `setup`, `teardown` — is
 * identity or wiring, and a patch that can reach them is a patch that can silently change which
 * app a test hits or which credentials it runs under. That is a different power from editing what
 * the test does, and the whole point of a whitelist is that the two are not the same grant.
 *
 * admitting a new root widens what a model-emitted pointer can retarget, so a move here is
 * a measurement, not a preference. Before adding one, produce (a) a NAMED authoring case that
 * cannot be expressed inside the current roots — an actual intent the loop failed to satisfy, not
 * a hypothetical; (b) a re-run of the frozen byte-diff corpus with a new refusal cell proving the
 * fence still refuses everything OUTSIDE the widened set, since a fence that only ever passes is
 * unmeasurable; and (c) the answer to what a patch reaching the new root can change about which
 * app the test drives — if the answer is "something", the root belongs behind a different grant,
 * not behind this list. Record the case and the corpus numbers beside the frozen expectations.
 */
export const EDITABLE_POINTER_ROOTS = ['steps', 'name', 'context'] as const

export type EditablePointerRoot = (typeof EDITABLE_POINTER_ROOTS)[number]

/**
 * Split a JSON Pointer into its decoded reference tokens (RFC-6901 §3).
 *
 * `~1` decodes to `/` and `~0` to `~`, in that order — reversing them turns `~01` into `/`
 * instead of `~1`. One decoder lives here so the fence below and the applier in `core` cannot
 * disagree about what a pointer addresses, which is the only way a whitelist can be bypassed
 * without anyone editing the whitelist.
 */
export function parseJsonPointer(path: string): string[] {
  if (path === '') return []
  return path
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}

/**
 * The first reference token of a pointer, or `undefined` for the whole-document pointer.
 *
 * `undefined` is not "no root" — it is the root, all of it. The fence treats it as outside the
 * editable set for that reason: `` `` addresses the identity fields too.
 */
export function pointerRootOf(path: string): string | undefined {
  return parseJsonPointer(path)[0]
}

/** Whether a pointer addresses a region a patch may touch at all. */
export function isEditablePointer(path: string): boolean {
  const root = pointerRootOf(path)
  if (root === undefined) return false
  return (EDITABLE_POINTER_ROOTS as readonly string[]).includes(root)
}
