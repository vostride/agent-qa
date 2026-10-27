// RE-SPELLED 2026-10-01 (432-19, D-15): the type-level twin of `430-remedy-memberships.test.ts`.
// It pinned each kind's exact surface members, the five doors and an empty dashboard projection;
// the vocabulary is deleted, so each type is now one a consumer cannot name. `@ts-expect-error` is
// two-way: a line fails `tsc --noEmit` the moment its type comes back.
// @ts-expect-error C432-REMEDY-TYPES-ABSENT: the remedy type is deleted
export type RetiredGateRemedy = import('../../index').GateRemedy
// @ts-expect-error C432-REMEDY-TYPES-ABSENT: the remedy kind union is deleted
export type RetiredGateRemedyKind = import('../../index').GateRemedyKind
// @ts-expect-error C432-REMEDY-TYPES-ABSENT: the remedy surface union is deleted
export type RetiredGateRemedySurface = import('../../index').GateRemedySurface
// @ts-expect-error C432-REMEDY-TYPES-ABSENT: the per-surface projection type is deleted
export type RetiredRemedyKindFor = import('../../index').RemedyKindFor<'cli'>
// @ts-expect-error C432-REMEDY-TYPES-ABSENT: the chat clause denial is deleted
export type RetiredClauseDenial = import('../../index').ClauseDenial
