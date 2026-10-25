// The compile-time half of the 414 D-19/D-20 bar on the proposer's read port (ROOT-10 SC5).
//
// The runtime cells in `reader.test.ts` prove the SHIPPED port does not hand back a private
// held-out entry. These bars prove it CANNOT: no return type of any method on `CorpusReader`
// admits `heldOutVisibility: 'private'`, so widening the implementation is not enough to leak —
// the type has to be widened too, and that REDs here by name.
//
// The third pin is the source-anchored export-set cell in
// `packages/arch/src/__tests__/validate-arch.test.ts`, which catches a NEW export joining the
// barrel — a case neither this file nor the key-set cell can see until someone imports it.
import { expectTypeOf } from 'vitest'
import type { CorpusReader } from '../corpus-reader.js'

// The list can never contain a private held-out entry. `ProposerVisibleCorpusEntry` is derived
// from `CorpusEntry` by exclusion, so a NEW private-ish arm added to the union in eval core does
// not silently become listable — it lands in the visible type and this bar keeps its meaning.
expectTypeOf<
  Extract<ReturnType<CorpusReader['listEntries']>[number], { heldOutVisibility: 'private' }>
>().toEqualTypeOf<never>()

// Neither load can return anything CARRYING a visibility marker at all: the loaded arm hands
// back a cassette or a label record, never the entry, so the split is not even in the shape.
expectTypeOf<
  Extract<ReturnType<CorpusReader['loadCassette']>, { heldOutVisibility: unknown }>
>().toEqualTypeOf<never>()
expectTypeOf<
  Extract<ReturnType<CorpusReader['loadLabel']>, { heldOutVisibility: unknown }>
>().toEqualTypeOf<never>()

// Exactly three methods. A `count`, a `listProducts` or a `has` would each be an existence
// channel over the unseen set (D-19), so the method set is pinned rather than merely reviewed.
expectTypeOf<keyof CorpusReader>().toEqualTypeOf<'listEntries' | 'loadCassette' | 'loadLabel'>()

// One parameter, and it is the product. A `visibility` argument is the most natural widening
// anyone would reach for, so the parameter LIST is pinned — not just the first parameter's type.
expectTypeOf<Parameters<CorpusReader['listEntries']>>().toEqualTypeOf<[product?: string]>()
