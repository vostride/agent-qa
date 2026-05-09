import { idAgent, parse } from 'id-agent'

export const CANONICAL_ID_WORDS = 10
export const LEGACY_OBSERVATION_ID_WORDS = 6

const PREFIX = {
  test: 't',
  suite: 's',
  hook: 'h',
  observation: 'obs',
  run: 'r',
} as const

type Prefix = (typeof PREFIX)[keyof typeof PREFIX]
export type EntityIdType = keyof typeof PREFIX

export const ENTITY_ID_TYPES = Object.keys(PREFIX) as EntityIdType[]

export interface EntityIdContract {
  type: EntityIdType
  prefix: Prefix
  prefixWithSeparator: `${Prefix}_`
  words: number
  examplePattern: string
}

function hasPrefixAndWordCount(value: string, prefix: Prefix, wordCount: number): boolean {
  const parsed = parse(value)
  return parsed?.prefix === prefix && parsed.wordCount === wordCount
}

function generateId(prefix: Prefix): string {
  return idAgent({ prefix, words: CANONICAL_ID_WORDS })
}

export function generateTestId(): string {
  return generateId(PREFIX.test)
}

export function generateSuiteId(): string {
  return generateId(PREFIX.suite)
}

export function generateObservationId(): string {
  return generateId(PREFIX.observation)
}

export function generateHookId(): string {
  return generateId(PREFIX.hook)
}

export function generateRunId(): string {
  return generateId(PREFIX.run)
}

export function generateCanonicalId(type: EntityIdType): string {
  return generateId(PREFIX[type])
}

export function isCanonicalTestId(value: string): boolean {
  return hasPrefixAndWordCount(value, PREFIX.test, CANONICAL_ID_WORDS)
}

export function isCanonicalSuiteId(value: string): boolean {
  return hasPrefixAndWordCount(value, PREFIX.suite, CANONICAL_ID_WORDS)
}

export function isCanonicalHookId(value: string): boolean {
  return hasPrefixAndWordCount(value, PREFIX.hook, CANONICAL_ID_WORDS)
}

export function isCanonicalObservationId(value: string): boolean {
  return hasPrefixAndWordCount(value, PREFIX.observation, CANONICAL_ID_WORDS)
}

export function isCanonicalRunId(value: string): boolean {
  return hasPrefixAndWordCount(value, PREFIX.run, CANONICAL_ID_WORDS)
}

export function isCanonicalId(type: EntityIdType, value: string): boolean {
  return hasPrefixAndWordCount(value, PREFIX[type], CANONICAL_ID_WORDS)
}

export function isObservationId(value: string): boolean {
  return isCanonicalObservationId(value)
    || hasPrefixAndWordCount(value, PREFIX.observation, LEGACY_OBSERVATION_ID_WORDS)
}

export function getEntityIdContract(type: EntityIdType): EntityIdContract {
  const prefix = PREFIX[type]
  return {
    type,
    prefix,
    prefixWithSeparator: `${prefix}_`,
    words: CANONICAL_ID_WORDS,
    examplePattern: `${prefix}_word-word-word-word-word-word-word-word-word-word`,
  }
}

export function getEntityIdContracts(): EntityIdContract[] {
  return ENTITY_ID_TYPES.map(type => getEntityIdContract(type))
}
