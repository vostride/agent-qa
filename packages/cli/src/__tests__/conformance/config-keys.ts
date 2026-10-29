// dotted config keys in guidance, resolved in the live schema

import { AgentQaConfigSchema } from '@vostride/agent-qa-core'

interface ZodDef {
  readonly type: string
  readonly [field: string]: unknown
}

interface KeySubject {
  readonly name: string
  readonly body: string
}

export const CONFIG_ROOT_KEYS: readonly string[] = Object.freeze(
  Object.keys(AgentQaConfigSchema.out.shape),
)

const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'md', 'json', 'yaml', 'yml', 'toml', 'ts', 'js', 'mjs', 'db', 'sqlite',
])
const DOTTED_SPAN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u
const ROOTED_KEY = new RegExp(
  `(?<![\\w./-])(?:${CONFIG_ROOT_KEYS.join('|')})(?:\\.[A-Za-z][A-Za-z0-9]*)+`,
  'gu',
)

function defOf(node: unknown): ZodDef {
  return (node as { readonly _zod: { readonly def: ZodDef } })._zod.def
}

function unwrapped(node: unknown, seen: Set<unknown> = new Set()): readonly unknown[] {
  if (seen.has(node)) return []
  seen.add(node)
  const def = defOf(node)
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return unwrapped(def.innerType, seen)
    case 'pipe':
      return unwrapped(def.out, seen)
    case 'lazy':
      return unwrapped((def.getter as () => unknown)(), seen)
    case 'union':
      return (def.options as readonly unknown[]).flatMap((option) => unwrapped(option, seen))
    case 'intersection':
      return [...unwrapped(def.left, seen), ...unwrapped(def.right, seen)]
    default:
      return [node]
  }
}

function step(node: unknown, segment: string): readonly unknown[] {
  return unwrapped(node).flatMap((inner) => {
    const def = defOf(inner)
    if (def.type === 'object') {
      const shape = def.shape as Readonly<Record<string, unknown>>
      return Object.hasOwn(shape, segment) ? [shape[segment]] : []
    }
    if (def.type === 'record') return [def.valueType]
    if (def.type === 'array') return step(def.element, segment)
    return []
  })
}

export function resolveConfigKey(path: string): boolean {
  let nodes: readonly unknown[] = [AgentQaConfigSchema]
  for (const segment of path.split('.')) {
    nodes = nodes.flatMap((node) => step(node, segment))
    if (nodes.length === 0) return false
  }
  return true
}

export function dottedKeyCandidates(text: string, opIds: ReadonlySet<string>): readonly string[] {
  const candidates = new Set<string>()
  for (const match of text.matchAll(/`([^`\n]+)`/gu)) {
    const span = (match[1] ?? '').trim()
    if (!DOTTED_SPAN.test(span) || opIds.has(span)) continue
    if (FILE_EXTENSIONS.has(span.slice(span.lastIndexOf('.') + 1))) continue
    candidates.add(span)
  }
  for (const match of text.matchAll(ROOTED_KEY)) {
    if (!opIds.has(match[0])) candidates.add(match[0])
  }
  return [...candidates]
}

export function configKeyFindings(
  subjects: readonly KeySubject[],
  opIds: ReadonlySet<string>,
): { readonly scanned: number; readonly findings: readonly string[] } {
  const findings: string[] = []
  let scanned = 0
  for (const subject of subjects) {
    for (const key of dottedKeyCandidates(subject.body, opIds)) {
      scanned += 1
      if (!resolveConfigKey(key)) findings.push(`${subject.name}: ${key} is not a config key`)
    }
  }
  findings.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  if (scanned === 0) findings.push('no config key was scanned')
  return { scanned, findings }
}
