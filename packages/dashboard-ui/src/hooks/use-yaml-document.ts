import { useCallback, useRef, useMemo } from "react"
import { parseDocument, type Document, isMap, isSeq } from "yaml"

function forceBlockStyle(doc: Document): void {
  function visit(node: unknown) {
    if (isMap(node)) {
      (node as any).flow = false
      for (const item of node.items) visit(item.value)
    }
    if (isSeq(node)) {
      (node as any).flow = false
      for (const item of node.items) visit(item)
    }
  }
  visit(doc.contents)
}

function pruneEmptyMaps(doc: Document): void {
  function visit(node: unknown): boolean {
    if (isMap(node)) {
      node.items = node.items.filter(item => !visit(item.value))
      return node.items.length === 0
    }
    return false
  }
  visit(doc.contents)
}

const TOP_LEVEL_ORDER = ['name', 'test-id', 'target', 'use', 'meta', 'context', 'steps']

function sortMapKeys(doc: Document): void {
  function visit(node: unknown, isRoot: boolean) {
    if (isMap(node)) {
      if (isRoot) {
        node.items.sort((a, b) => {
          const ai = TOP_LEVEL_ORDER.indexOf(String(a.key))
          const bi = TOP_LEVEL_ORDER.indexOf(String(b.key))
          const ao = ai === -1 ? TOP_LEVEL_ORDER.length : ai
          const bo = bi === -1 ? TOP_LEVEL_ORDER.length : bi
          return ao - bo
        })
      } else {
        node.items.sort((a, b) => String(a.key).localeCompare(String(b.key)))
      }
      for (const item of node.items) visit(item.value, false)
    }
  }
  visit(doc.contents, true)
}

function toCleanYaml(doc: Document): string {
  pruneEmptyMaps(doc)
  forceBlockStyle(doc)
  sortMapKeys(doc)
  return doc.toString()
}

interface UseYamlDocumentReturn {
  doc: Document | null
  error: string | null
  getIn: (path: string[]) => unknown
  setIn: (path: string[], value: unknown) => string
  deleteIn: (path: string[]) => string
}

export function useYamlDocument(content: string): UseYamlDocumentReturn {
  const lastValidRef = useRef<Document | null>(null)

  const { doc, error } = useMemo(() => {
    if (!content) {
      return { doc: null, error: null }
    }
    try {
      const parsed = parseDocument(content)
      lastValidRef.current = parsed
      return { doc: parsed, error: null }
    } catch (e) {
      return {
        doc: lastValidRef.current,
        error: e instanceof Error ? e.message : "Invalid YAML",
      }
    }
  }, [content])

  const getIn = useCallback(
    (path: string[]) => {
      if (!doc) return undefined
      return doc.getIn(path)
    },
    [doc],
  )

  const setIn = useCallback(
    (path: string[], value: unknown): string => {
      const freshDoc = parseDocument(content)
      freshDoc.setIn(path, value)
      return toCleanYaml(freshDoc)
    },
    [content],
  )

  const deleteIn = useCallback(
    (path: string[]): string => {
      const freshDoc = parseDocument(content)
      freshDoc.deleteIn(path)
      return toCleanYaml(freshDoc)
    },
    [content],
  )

  return { doc, error, getIn, setIn, deleteIn }
}
