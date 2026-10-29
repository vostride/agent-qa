// Not the unified-diff `patch/` vocabulary: these ops address positions in a parsed document.

import { z } from 'zod'

// `move` and `copy` would give the fence two pointers to check, so only three ops are admitted.
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

// Always a string: the CST applier preserves untouched bytes only because each write is one scalar.
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

// `thoughts` is required but may be empty; an empty `patches` is a no-op, not an error.
export const TestEditPatchSetSchema = z.object({
  thoughts: z.string(),
  patches: z.array(PatchOpSchema),
}).strict()

export type TestEditPatchSet = z.infer<typeof TestEditPatchSetSchema>

// Other roots set which app a test hits or which credentials it uses, so patches cannot reach them.
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
