// Row text is opaque comparison data; an unknown row never contradicts.

import type { ElementInfo, Ref } from '@vostride/agent-qa-schema'

export const ROW_CONTAINER_ROLES: readonly string[] = ['row', 'listitem', 'article', 'treeitem']

const FALLBACK_CONTAINER_ROLE = 'cell'

const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/u
const NUMBER_TOKEN = /^\p{N}+$/u
const MIN_PREFIX_LENGTH = 2
const NO_BREAK_GROUP_SEPARATOR = /(?<=\p{N})[\u00A0\u202F](?=\p{N}{3}(?!\p{N}))/gu
const GROUP_SEPARATOR = /(?<=\p{N})[,_](?=\p{N}{3}(?!\p{N}))/gu
const UNDERSCORE_GROUP_SEPARATOR = /(?<=\p{N})_(?=\p{N}{3}(?!\p{N}))/gu
const LAKH_GROUP = /(?<!\p{N},?)\p{N}{1,2}(?:,\p{N}{2})+,\p{N}{3}(?!\p{N}|,\p{N})/gu

function tokens(text: string | undefined, commasGroup: boolean): string[] {
  if (text === undefined) return []
  const normalized = text.replace(NO_BREAK_GROUP_SEPARATOR, '').normalize('NFKC')
  const grouped = commasGroup
    ? normalized
        .replace(LAKH_GROUP, (group) => group.replace(/,/g, ''))
        .replace(GROUP_SEPARATOR, '')
    : normalized.replace(UNDERSCORE_GROUP_SEPARATOR, '')
  return grouped
    .toLowerCase()
    .split(NOT_LETTER_OR_DIGIT)
    .filter((word) => word.length > 0)
}

/**
 * Word tokens of a text: digit groups joined, NFKC, lowercased, split on every run that is not a
 * letter or digit.
 */
export function wordTokens(text: string | undefined): string[] {
  return tokens(text, true)
}

export function listWordTokens(text: string | undefined): string[] {
  return tokens(text, false)
}

function isNumber(word: string): boolean {
  return NUMBER_TOKEN.test(word)
}

function ancestorsOf(element: ElementInfo, byRef: Map<Ref, ElementInfo>): ElementInfo[] {
  const chain: ElementInfo[] = []
  const seen = new Set<Ref>([element.ref])
  let parentRef = element.hierarchy?.parentRef
  while (parentRef !== undefined && !seen.has(parentRef)) {
    seen.add(parentRef)
    const parent = byRef.get(parentRef)
    if (parent === undefined) break
    chain.push(parent)
    parentRef = parent.hierarchy?.parentRef
  }
  return chain
}

function rowContainerOf(
  element: ElementInfo,
  byRef: Map<Ref, ElementInfo>,
): ElementInfo | undefined {
  const chain = [element, ...ancestorsOf(element, byRef)]
  return (
    chain.find((candidate) => ROW_CONTAINER_ROLES.includes(candidate.role))
    ?? chain.find((candidate) => candidate.role === FALLBACK_CONTAINER_ROLE)
  )
}

function descendantsInOrder(
  container: ElementInfo,
  elements: readonly ElementInfo[],
  byRef: Map<Ref, ElementInfo>,
): ElementInfo[] {
  return elements.filter(
    (candidate) =>
      candidate.ref !== container.ref
      && ancestorsOf(candidate, byRef).some((ancestor) => ancestor.ref === container.ref),
  )
}

// Undefined when the element has no row container or its text is empty: the row is unknown.
export function rowTextOf(
  element: ElementInfo,
  elements: readonly ElementInfo[],
): string | undefined {
  const byRef = new Map<Ref, ElementInfo>()
  for (const candidate of elements) byRef.set(candidate.ref, candidate)
  const container = rowContainerOf(element, byRef)
  if (container === undefined) return undefined

  const parts: string[] = [container.name, container.text ?? '']
  for (const descendant of descendantsInOrder(container, elements, byRef)) {
    parts.push(descendant.name, descendant.text ?? '')
  }
  if (container.ref === element.ref && ROW_CONTAINER_ROLES.includes(element.role)) {
    for (const enclosing of ancestorsOf(element, byRef)) {
      if (enclosing.role === element.role) parts.push(enclosing.name, enclosing.text ?? '')
    }
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
  return joined.length > 0 ? joined : undefined
}

/** Whether every stated row word is in the row text (equal, or a prefix of a non-number word). */
export function rowContains(rowText: string, statedRow: string): boolean {
  return [wordTokens, listWordTokens].some((read) => {
    const rowWords = read(rowText)
    const statedWords = read(statedRow)
    if (statedWords.length === 0) return true
    return statedWords.every((stated) =>
      rowWords.some((word) => {
        if (word === stated) return true
        if (isNumber(stated) || isNumber(word)) return false
        return stated.length >= MIN_PREFIX_LENGTH && word.startsWith(stated)
      }),
    )
  })
}
