export type RunAttributes = Record<string, string>

export const INTERNAL_ATTRIBUTE_PREFIX = 'agent-qa.'
export const ATTR_TRIGGER = 'agent-qa.trigger'
export const ATTR_RUNNER = 'agent-qa.runner'

export type RunAttributeTrigger = 'cli' | 'dashboard' | 'api' | 'mcp'
export type RunAttributeRunner = 'local' | 'browserstack'

export const RUN_ATTRIBUTE_KEY_MAX_LENGTH = 256
export const RUN_ATTRIBUTE_VALUE_MAX_LENGTH = 4096
const RUN_ATTRIBUTE_TRIGGERS: RunAttributeTrigger[] = ['cli', 'dashboard', 'api', 'mcp']
const RUN_ATTRIBUTE_RUNNERS: RunAttributeRunner[] = ['local', 'browserstack']

export interface ParsedRunAttrFlags {
  attributes: RunAttributes
  duplicateKeys: string[]
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertValidUserAttributeKey(key: string, sourceLabel: string): void {
  if (key.length === 0) {
    throw new Error(`${sourceLabel}: Attribute key must be non-empty`)
  }
  if (key.startsWith(INTERNAL_ATTRIBUTE_PREFIX)) {
    throw new Error(`${sourceLabel}: Attribute key "${key}" uses the reserved prefix "${INTERNAL_ATTRIBUTE_PREFIX}"`)
  }
  if (key.length > RUN_ATTRIBUTE_KEY_MAX_LENGTH) {
    throw new Error(`${sourceLabel}: Attribute key "${key}" exceeds ${RUN_ATTRIBUTE_KEY_MAX_LENGTH} characters`)
  }
}

function assertValidAttributeKeyShape(key: string, sourceLabel: string): void {
  if (key.length === 0) {
    throw new Error(`${sourceLabel}: Attribute key must be non-empty`)
  }
  if (key.length > RUN_ATTRIBUTE_KEY_MAX_LENGTH) {
    throw new Error(`${sourceLabel}: Attribute key "${key}" exceeds ${RUN_ATTRIBUTE_KEY_MAX_LENGTH} characters`)
  }
}

function assertValidAttributeValue(key: string, value: unknown, sourceLabel: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`${sourceLabel}: Attribute value for "${key}" must be a string`)
  }
  if (value.length > RUN_ATTRIBUTE_VALUE_MAX_LENGTH) {
    throw new Error(`${sourceLabel}: Attribute value for "${key}" exceeds ${RUN_ATTRIBUTE_VALUE_MAX_LENGTH} characters`)
  }
}

function assertValidInternalAttribute(key: string, value: string, sourceLabel: string): void {
  if (key === ATTR_TRIGGER) {
    if (!RUN_ATTRIBUTE_TRIGGERS.includes(value as RunAttributeTrigger)) {
      throw new Error(`${sourceLabel}: Attribute value for "${key}" must be one of: ${RUN_ATTRIBUTE_TRIGGERS.join(', ')}`)
    }
    return
  }
  if (key === ATTR_RUNNER) {
    if (!RUN_ATTRIBUTE_RUNNERS.includes(value as RunAttributeRunner)) {
      throw new Error(`${sourceLabel}: Attribute value for "${key}" must be one of: ${RUN_ATTRIBUTE_RUNNERS.join(', ')}`)
    }
    return
  }
  throw new Error(`${sourceLabel}: Attribute key "${key}" uses the reserved prefix "${INTERNAL_ATTRIBUTE_PREFIX}"`)
}

export function validateUserRunAttributes(input: unknown, sourceLabel = 'run attributes'): RunAttributes {
  if (input === undefined || input === null) return {}
  if (!isPlainRecord(input)) {
    throw new Error(`${sourceLabel}: attributes must be a plain object`)
  }

  const attributes = Object.create(null) as RunAttributes
  for (const [key, value] of Object.entries(input)) {
    assertValidUserAttributeKey(key, sourceLabel)
    if (typeof value !== 'string') {
      throw new Error(`${sourceLabel}: Attribute value for "${key}" must be a string`)
    }
    if (value.length > RUN_ATTRIBUTE_VALUE_MAX_LENGTH) {
      throw new Error(`${sourceLabel}: Attribute value for "${key}" exceeds ${RUN_ATTRIBUTE_VALUE_MAX_LENGTH} characters`)
    }
    attributes[key] = value
  }
  return attributes
}

export function validateTrustedRunAttributes(input: unknown, sourceLabel = 'run attributes'): RunAttributes {
  if (input === undefined || input === null) return {}
  if (!isPlainRecord(input)) {
    throw new Error(`${sourceLabel}: attributes must be a plain object`)
  }

  const attributes = Object.create(null) as RunAttributes
  for (const [key, value] of Object.entries(input)) {
    assertValidAttributeKeyShape(key, sourceLabel)
    assertValidAttributeValue(key, value, sourceLabel)
    if (key.startsWith(INTERNAL_ATTRIBUTE_PREFIX)) {
      assertValidInternalAttribute(key, value, sourceLabel)
    }
    attributes[key] = value
  }
  return attributes
}

export function parseRunAttrFlags(flags: string[] | undefined): ParsedRunAttrFlags {
  const rawAttributes = Object.create(null) as Record<string, string>
  const seen = new Set<string>()
  const duplicateKeys = new Set<string>()

  for (const flag of flags ?? []) {
    const separator = flag.indexOf('=')
    if (separator <= 0) {
      throw new Error(`--run-attr must use KEY=VALUE format: "${flag}"`)
    }
    const key = flag.slice(0, separator)
    const value = flag.slice(separator + 1)
    if (seen.has(key)) duplicateKeys.add(key)
    seen.add(key)
    rawAttributes[key] = value
  }

  return {
    attributes: validateUserRunAttributes(rawAttributes, '--run-attr'),
    duplicateKeys: [...duplicateKeys].sort((left, right) => left.localeCompare(right)),
  }
}

export function buildInternalRunAttributes(input: {
  trigger: RunAttributeTrigger
  runner: RunAttributeRunner
}): RunAttributes {
  return {
    [ATTR_TRIGGER]: input.trigger,
    [ATTR_RUNNER]: input.runner,
  }
}

export function mergeRunAttributes(internal: RunAttributes, user: RunAttributes): RunAttributes {
  return {
    ...user,
    ...internal,
  }
}

export function sortRunAttributesForDisplay(
  attributes: RunAttributes,
  activeKeys: string[] = [],
): Array<[string, string]> {
  const entries = Object.entries(attributes)
  const rank = (key: string): [number, number, string] => {
    const activeIndex = activeKeys.indexOf(key)
    if (activeIndex >= 0) return [0, activeIndex, key]
    if (key === ATTR_TRIGGER) return [1, 0, key]
    if (key === ATTR_RUNNER) return [1, 1, key]
    if (key.startsWith(INTERNAL_ATTRIBUTE_PREFIX)) return [1, 2, key]
    return [2, 0, key]
  }

  return entries.sort(([left], [right]) => {
    const leftRank = rank(left)
    const rightRank = rank(right)
    return leftRank[0] - rightRank[0] ||
      leftRank[1] - rightRank[1] ||
      leftRank[2].localeCompare(rightRank[2])
  })
}

export function formatRunAttributesBlock(attributes: RunAttributes): string {
  const entries = sortRunAttributesForDisplay(attributes)
  if (entries.length === 0) return ''
  return [
    'Run attributes:',
    ...entries.map(([key, value]) => `  ${key}=${value}`),
  ].join('\n')
}
