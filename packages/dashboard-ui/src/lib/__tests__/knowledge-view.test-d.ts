// 427 · D-02, D-07 — the Knowledge tab's closed sets, pinned in both directions (v54 bar). A member
// added to the union alone compiles everywhere and is never painted; this bar catches that half.

import { expectTypeOf, test } from 'vitest'
import type {
  BundleStatus as SchemaBundleStatus,
  CurationBucket,
  InspectRecordView,
  RetrievalRungReason,
  RunKnowledgePlanSource,
  RunKnowledgeRecordContent,
} from '@vostride/agent-qa-schema'
import {
  ANCHOR_PHRASE_TYPES,
  BUCKET_LABELS,
  CURRENT_STATUS_WORDS,
  EFFECT_OUTCOMES,
  EFFECT_SENTENCES,
  EFFECT_TONES,
  EFFECT_TONE_OF,
  KNOWLEDGE_SECTIONS,
  LEDGER_ROW_LABELS,
  REPLAY_STOP_CAUSES,
  RECORD_KIND_LABELS,
  RETRIEVAL_CLASSES,
  RETRIEVAL_CLASS_BY_REASON,
  RETRIEVAL_CLASS_TONES,
  SINCE_STATUS_TAGS,
  SINCE_THEN_DETAILS,
  USE_VERBS,
  USE_VERB_PHRASES,
  type AnchorPhraseType,
  type BundleStatus,
  type EffectOutcome,
  type EffectTone,
  type KnowledgeSection,
  type LearnedChangeKind,
  type LedgerRow,
  type ReplayStopCause,
  type RecordKind,
  type RetrievalClass,
  type RetrievalTone,
  type UseVerb,
} from '../knowledge-view'

test('knowledge sections are an exact union', () => {
  type Expected = 'used' | 'effect' | 'changes' | 'retrieval-details'
  expectTypeOf<KnowledgeSection>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof KNOWLEDGE_SECTIONS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<KnowledgeSection, (typeof KNOWLEDGE_SECTIONS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof KNOWLEDGE_SECTIONS)[number], KnowledgeSection>>().toEqualTypeOf<never>()
})

test('use verbs are an exact union, and each has a phrase', () => {
  type Expected = 'given' | 'opened' | 'caution' | 'replayed' | 'hint'
  expectTypeOf<UseVerb>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof USE_VERBS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<UseVerb, (typeof USE_VERBS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof USE_VERBS)[number], UseVerb>>().toEqualTypeOf<never>()
  expectTypeOf<keyof typeof USE_VERB_PHRASES>().toEqualTypeOf<UseVerb>()
})

test('record kinds match the inspect view and the record content, and each has a label', () => {
  type Expected = 'fact' | 'procedure' | 'caution' | 'unknown' | 'policy'
  expectTypeOf<RecordKind>().toEqualTypeOf<Expected>()
  expectTypeOf<RecordKind>().toEqualTypeOf<InspectRecordView['kind']>()
  expectTypeOf<RunKnowledgeRecordContent['kind']>().toEqualTypeOf<RecordKind>()
  expectTypeOf<keyof typeof RECORD_KIND_LABELS>().toEqualTypeOf<RecordKind>()
})

test('anchor phrase types are an exact union', () => {
  type Expected = 'platform' | 'page' | 'flow' | 'el' | 'selector' | 'error' | 'unparsed'
  expectTypeOf<AnchorPhraseType>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof ANCHOR_PHRASE_TYPES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<AnchorPhraseType, (typeof ANCHOR_PHRASE_TYPES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof ANCHOR_PHRASE_TYPES)[number], AnchorPhraseType>>().toEqualTypeOf<never>()
})

test('bundle statuses match the schema, and each has a tag and a word', () => {
  type Expected = 'active' | 'candidate' | 'superseded' | 'deprecated'
  expectTypeOf<BundleStatus>().toEqualTypeOf<Expected>()
  expectTypeOf<BundleStatus>().toEqualTypeOf<SchemaBundleStatus>()
  expectTypeOf<BundleStatus>().toEqualTypeOf<RunKnowledgeRecordContent['currentStatus']>()
  expectTypeOf<keyof typeof SINCE_STATUS_TAGS>().toEqualTypeOf<BundleStatus>()
  expectTypeOf<keyof typeof CURRENT_STATUS_WORDS>().toEqualTypeOf<BundleStatus>()
})

test('effect outcomes are an exact union', () => {
  type Expected =
    | 'contradicted'
    | 'harmful'
    | 'replay-stopped'
    | 'confirmed'
    | 'helpful'
    | 'replay-complete'
    | 'pending'
    | 'unknown'
  expectTypeOf<EffectOutcome>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof EFFECT_OUTCOMES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<EffectOutcome, (typeof EFFECT_OUTCOMES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof EFFECT_OUTCOMES)[number], EffectOutcome>>().toEqualTypeOf<never>()
  expectTypeOf<keyof typeof EFFECT_TONE_OF>().toEqualTypeOf<EffectOutcome>()
  expectTypeOf<keyof typeof EFFECT_SENTENCES>().toEqualTypeOf<Exclude<EffectOutcome, 'replay-stopped' | 'replay-complete'>>()
})

test('effect tones are an exact union, and every outcome has one', () => {
  type Expected = 'problem' | 'positive' | 'pending' | 'unknown'
  expectTypeOf<EffectTone>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof EFFECT_TONES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<EffectTone, (typeof EFFECT_TONES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof EFFECT_TONES)[number], EffectTone>>().toEqualTypeOf<never>()
  expectTypeOf<(typeof EFFECT_TONE_OF)[EffectOutcome]>().toEqualTypeOf<EffectTone>()
})

test("replay stop causes are the guard's miss reasons plus execution failure and verifier rejection", () => {
  type MissReason = NonNullable<Extract<RunKnowledgePlanSource, { kind: 'procedure-replay' }>['guard']['miss']>['reason']
  expectTypeOf<ReplayStopCause>().toEqualTypeOf<MissReason | 'execution-failure' | 'verifier-rejection'>()
  expectTypeOf<keyof typeof REPLAY_STOP_CAUSES>().toEqualTypeOf<ReplayStopCause>()
})

test('curation buckets, change kinds and ledger rows each have a label', () => {
  type Expected = 'added' | 'confirmed' | 'superseded' | 'deprecated' | 'proposed'
  expectTypeOf<CurationBucket>().toEqualTypeOf<Expected>()
  expectTypeOf<keyof typeof BUCKET_LABELS>().toEqualTypeOf<CurationBucket>()
  expectTypeOf<keyof typeof SINCE_THEN_DETAILS>().toEqualTypeOf<LearnedChangeKind>()
  expectTypeOf<keyof typeof LEDGER_ROW_LABELS>().toEqualTypeOf<LedgerRow>()
})

test('retrieval classes are an exact union, and each has a tone', () => {
  type Expected = 'fresh-index' | 'cause-not-recorded' | 'index-problem' | 'semantic-search-unavailable' | 'by-configuration'
  expectTypeOf<RetrievalClass>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof RETRIEVAL_CLASSES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<RetrievalClass, (typeof RETRIEVAL_CLASSES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof RETRIEVAL_CLASSES)[number], RetrievalClass>>().toEqualTypeOf<never>()
  expectTypeOf<RetrievalTone>().toEqualTypeOf<'info' | 'warning'>()
  expectTypeOf<keyof typeof RETRIEVAL_CLASS_TONES>().toEqualTypeOf<RetrievalClass>()
  expectTypeOf<(typeof RETRIEVAL_CLASS_TONES)[RetrievalClass]>().toEqualTypeOf<RetrievalTone>()
})

test('every retrieval rung reason maps to a retrieval class', () => {
  expectTypeOf<keyof typeof RETRIEVAL_CLASS_BY_REASON>().toEqualTypeOf<RetrievalRungReason>()
  expectTypeOf<(typeof RETRIEVAL_CLASS_BY_REASON)[RetrievalRungReason]>().toEqualTypeOf<RetrievalClass>()
})
