import * as monaco from 'monaco-editor'

import { t } from '@/i18n'
import type editor from '@/i18n/locales/en/editor'

export const LLM_PROVIDER_COMPLETION_VALUES = [
  'openai-compatible',
  'anthropic-compatible',
  'openai-subscription',
  'anthropic-subscription',
  'gemini',
] as const

type DocumentationKey = Extract<keyof typeof editor, `editor.yaml.${string}`>

interface SchemaField {
  label: string
  detail: string
  documentation?: DocumentationKey
  kind: 'object' | 'string' | 'number' | 'boolean' | 'array' | 'enum'
  enumValues?: string[]
  children?: SchemaField[]
}

// Static schema field map derived from TestDefinitionSchema.
// Built manually to avoid importing @vostride/agent-qa-core (Node.js-only code) in the browser.
const SCHEMA_MAP: SchemaField = {
  label: 'root',
  kind: 'object',
  detail: 'Test definition',
  children: [
    { label: 'name', kind: 'string', detail: 'string (required)', documentation: 'editor.yaml.name' },
    { label: 'target', kind: 'string', detail: 'string (required)', documentation: 'editor.yaml.target' },
    { label: 'context', kind: 'string', detail: 'string', documentation: 'editor.yaml.context' },
    {
      label: 'setup',
      kind: 'array',
      detail: 'string[]',
      documentation: 'editor.yaml.setup',
    },
    {
      label: 'steps',
      kind: 'array',
      detail: 'string[] (required)',
      documentation: 'editor.yaml.steps',
    },
    {
      label: 'teardown',
      kind: 'array',
      detail: 'string[]',
      documentation: 'editor.yaml.teardown',
    },
    {
      label: 'variables',
      kind: 'object',
      detail: 'Record<string, string>',
      documentation: 'editor.yaml.variables',
    },
    {
      label: 'config',
      kind: 'object',
      detail: 'object',
      documentation: 'editor.yaml.config',
      children: [
        {
          label: 'browser',
          kind: 'object',
          detail: 'object',
          documentation: 'editor.yaml.config.browser',
          children: [
            { label: 'name', kind: 'enum', detail: 'enum', enumValues: ['chromium', 'firefox', 'webkit'], documentation: 'editor.yaml.config.browser.name' },
            { label: 'headless', kind: 'boolean', detail: 'boolean', documentation: 'editor.yaml.config.browser.headless' },
            {
              label: 'viewport',
              kind: 'object',
              detail: 'object',
              documentation: 'editor.yaml.config.browser.viewport',
              children: [
                { label: 'width', kind: 'number', detail: 'number', documentation: 'editor.yaml.config.browser.viewport.width' },
                { label: 'height', kind: 'number', detail: 'number', documentation: 'editor.yaml.config.browser.viewport.height' },
              ],
            },
          ],
        },
        {
          label: 'device',
          kind: 'object',
          detail: 'object',
          documentation: 'editor.yaml.config.device',
          children: [
            { label: 'platform', kind: 'enum', detail: 'enum', enumValues: ['android', 'ios'], documentation: 'editor.yaml.config.device.platform' },
            { label: 'model', kind: 'string', detail: 'string', documentation: 'editor.yaml.config.device.model' },
            { label: 'os', kind: 'string', detail: 'string', documentation: 'editor.yaml.config.device.os' },
            { label: 'id', kind: 'string', detail: 'string', documentation: 'editor.yaml.config.device.id' },
            { label: 'remote', kind: 'string', detail: 'string', documentation: 'editor.yaml.config.device.remote' },
            { label: 'capabilities', kind: 'object', detail: 'Record<string, unknown>', documentation: 'editor.yaml.config.device.capabilities' },
          ],
        },
        {
          label: 'llm',
          kind: 'object',
          detail: 'object',
          documentation: 'editor.yaml.config.llm',
          children: [
            { label: 'provider', kind: 'enum', detail: 'enum', enumValues: [...LLM_PROVIDER_COMPLETION_VALUES], documentation: 'editor.yaml.config.llm.provider' },
            { label: 'model', kind: 'string', detail: 'string', documentation: 'editor.yaml.config.llm.model' },
            { label: 'baseURL', kind: 'string', detail: 'string', documentation: 'editor.yaml.config.llm.baseURL' },
            { label: 'providerHeaders', kind: 'object', detail: 'Record<string, string>', documentation: 'editor.yaml.config.llm.providerHeaders' },
          ],
        },
        {
          label: 'timeout',
          kind: 'object',
          detail: 'object',
          documentation: 'editor.yaml.config.timeout',
          children: [
            { label: 'step', kind: 'string', detail: 'string', documentation: 'editor.yaml.config.timeout.step' },
            { label: 'test', kind: 'string', detail: 'string', documentation: 'editor.yaml.config.timeout.test' },
            { label: 'navigation', kind: 'string', detail: 'string', documentation: 'editor.yaml.config.timeout.navigation' },
          ],
        },
      ],
    },
    {
      label: 'use',
      kind: 'object',
      detail: 'object',
      documentation: 'editor.yaml.use',
      children: [
        { label: 'device', kind: 'string', detail: 'string', documentation: 'editor.yaml.use.device' },
        {
          label: 'mobile',
          kind: 'object',
          detail: 'object',
          documentation: 'editor.yaml.use.mobile',
          children: [
            { label: 'appState', kind: 'enum', detail: 'enum', enumValues: ['preserve', 'reset'], documentation: 'editor.yaml.use.mobile.appState' },
          ],
        },
      ],
    },
    {
      label: 'meta',
      kind: 'object',
      detail: 'object',
      documentation: 'editor.yaml.meta',
      children: [
        { label: 'timeout', kind: 'string', detail: 'string', documentation: 'editor.yaml.meta.timeout' },
        { label: 'retries', kind: 'number', detail: 'number', documentation: 'editor.yaml.meta.retries' },
        { label: 'record', kind: 'boolean', detail: 'boolean', documentation: 'editor.yaml.meta.record' },
      ],
    },
    {
      label: 'matrix',
      kind: 'object',
      detail: 'object',
      documentation: 'editor.yaml.matrix',
      children: [
        {
          label: 'dimensions',
          kind: 'object',
          detail: 'Record<string, string[]>',
          documentation: 'editor.yaml.matrix.dimensions',
        },
        { label: 'include', kind: 'array', detail: 'object[]', documentation: 'editor.yaml.matrix.include' },
        { label: 'exclude', kind: 'array', detail: 'object[]', documentation: 'editor.yaml.matrix.exclude' },
        { label: 'failFast', kind: 'boolean', detail: 'boolean', documentation: 'editor.yaml.matrix.failFast' },
      ],
    },
  ],
}

function findFieldAtPath(path: readonly string[]): SchemaField | undefined {
  let current: SchemaField = SCHEMA_MAP
  for (const segment of path) {
    if (!current.children) return undefined
    const child = current.children.find(c => c.label === segment)
    if (!child) return undefined
    current = child
  }
  return current
}

export function yamlKeyDocumentation(path: readonly string[]): string | undefined {
  const key = findFieldAtPath(path)?.documentation
  if (!key) return undefined
  return key === 'editor.yaml.variables' ? t(key, { syntax: '{{env:varName}}' }) : t(key)
}

// Parse lines above cursor to determine the YAML path at the cursor position
function getYamlPath(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): { path: string[]; isValue: boolean } {
  const lineContent = model.getLineContent(position.lineNumber)
  const textBeforeCursor = lineContent.substring(0, position.column - 1)

  // Check if we're in value position (after "key: ")
  const valueMatch = textBeforeCursor.match(/^(\s*)([\w-]+):\s+/)
  const isValue = !!valueMatch

  // Get current line indentation
  const currentIndent = lineContent.search(/\S/)

  // Walk backwards to build path from parent keys
  const path: string[] = []
  let targetIndent = currentIndent

  if (isValue && valueMatch) {
    // We're after "key: " — the path should include this key
    // First, find parents
    const key = valueMatch[2]
    const keyIndent = valueMatch[1].length

    // Walk up to find parents
    for (let i = position.lineNumber - 1; i >= 1; i--) {
      const line = model.getLineContent(i)
      const trimmed = line.trimStart()
      if (!trimmed || trimmed.startsWith('#')) continue

      const indent = line.search(/\S/)
      const parentMatch = trimmed.match(/^([\w-]+):/)
      if (parentMatch && indent < keyIndent) {
        path.unshift(parentMatch[1])
        if (indent === 0) break
        targetIndent = indent
        for (let j = i - 1; j >= 1; j--) {
          const pLine = model.getLineContent(j)
          const pTrimmed = pLine.trimStart()
          if (!pTrimmed || pTrimmed.startsWith('#')) continue
          const pIndent = pLine.search(/\S/)
          const pMatch = pTrimmed.match(/^([\w-]+):/)
          if (pMatch && pIndent < targetIndent) {
            path.unshift(pMatch[1])
            targetIndent = pIndent
            if (pIndent === 0) break
          }
        }
        break
      }
    }

    path.push(key)
    return { path, isValue: true }
  }

  // We're in key position — find parent path based on indentation
  if (currentIndent <= 0) {
    return { path: [], isValue: false }
  }

  targetIndent = currentIndent
  for (let i = position.lineNumber - 1; i >= 1; i--) {
    const line = model.getLineContent(i)
    const trimmed = line.trimStart()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('- ')) continue

    const indent = line.search(/\S/)
    const keyMatch = trimmed.match(/^([\w-]+):/)
    if (keyMatch && indent < targetIndent) {
      path.unshift(keyMatch[1])
      targetIndent = indent
      if (indent === 0) break
    }
  }

  return { path, isValue: false }
}

let registered = false

export function registerYamlCompletions() {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [':', ' ', '\n'],
    provideCompletionItems(model, position) {
      const { path, isValue } = getYamlPath(model, position)

      const word = model.getWordUntilPosition(position)
      const range: monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      }

      if (isValue) {
        // Suggest enum values for the field at path
        const field = findFieldAtPath(path)
        if (!field) return { suggestions: [] }

        if (field.kind === 'enum' && field.enumValues) {
          return {
            suggestions: field.enumValues.map((val, i) => ({
              label: val,
              kind: monaco.languages.CompletionItemKind.EnumMember,
              insertText: val,
              range,
              sortText: String(i).padStart(3, '0'),
              detail: field.detail,
            })),
          }
        }

        if (field.kind === 'boolean') {
          return {
            suggestions: ['true', 'false'].map((val, i) => ({
              label: val,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: val,
              range,
              sortText: String(i).padStart(3, '0'),
            })),
          }
        }

        return { suggestions: [] }
      }

      // Key position — suggest child fields of the parent
      const parent = findFieldAtPath(path)
      if (!parent?.children) {
        // If at root level, suggest from root
        if (path.length === 0) {
          return {
            suggestions: SCHEMA_MAP.children!.map((field, i) => ({
              label: field.label,
              kind: fieldKindToCompletionKind(field.kind),
              insertText: field.kind === 'object' ? `${field.label}:\n  ` : field.kind === 'array' ? `${field.label}:\n  - ` : `${field.label}: `,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.None,
              range,
              sortText: String(i).padStart(3, '0'),
              detail: field.detail,
              documentation: yamlKeyDocumentation([field.label]),
            })),
          }
        }
        return { suggestions: [] }
      }

      return {
        suggestions: parent.children.map((field, i) => ({
          label: field.label,
          kind: fieldKindToCompletionKind(field.kind),
          insertText: field.kind === 'object' ? `${field.label}:\n  ` : field.kind === 'array' ? `${field.label}:\n  - ` : `${field.label}: `,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.None,
          range,
          sortText: String(i).padStart(3, '0'),
          detail: field.detail,
          documentation: yamlKeyDocumentation([...path, field.label]),
        })),
      }
    },
  })
}

function fieldKindToCompletionKind(kind: SchemaField['kind']): monaco.languages.CompletionItemKind {
  switch (kind) {
    case 'object': return monaco.languages.CompletionItemKind.Module
    case 'string': return monaco.languages.CompletionItemKind.Value
    case 'number': return monaco.languages.CompletionItemKind.Value
    case 'boolean': return monaco.languages.CompletionItemKind.Value
    case 'array': return monaco.languages.CompletionItemKind.Property
    case 'enum': return monaco.languages.CompletionItemKind.Enum
    default: return monaco.languages.CompletionItemKind.Property
  }
}
