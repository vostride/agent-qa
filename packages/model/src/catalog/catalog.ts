import type { ModelProviderId } from '@vostride/agent-qa-schema'

import { matchFamily } from '../capability/family-table.js'

interface AuthoredEntry {
  id: string
  label: string
  notes?: string
  vision?: boolean
}

export interface CatalogEntry {
  id: string
  label: string
  vision: boolean
  notes?: string
}

export function deriveVision(id: string, override?: boolean): boolean {
  return override ?? matchFamily(id)?.vision ?? false
}

function expose(entry: AuthoredEntry): CatalogEntry {
  return {
    id: entry.id,
    label: entry.label,
    vision: deriveVision(entry.id, entry.vision),
    ...(entry.notes ? { notes: entry.notes } : {}),
  }
}

const CLAUDE: readonly AuthoredEntry[] = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]

const OPENAI_CLOUD: readonly AuthoredEntry[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-4.1', label: 'GPT-4.1' },
  { id: 'o3', label: 'o3' },
  { id: 'o4-mini', label: 'o4-mini' },
]

const LOCAL_OPENAI_WIRE: readonly AuthoredEntry[] = [
  {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    notes: 'Text-only model; use the accessibility tree.',
  },
  { id: 'deepseek-r1', label: 'DeepSeek R1', notes: 'Text-only reasoning model.' },
  { id: 'qwen2.5-vl', label: 'Qwen2.5 VL' },
  { id: 'llava', label: 'LLaVA' },
  { id: 'llama3.2-vision', label: 'Llama 3.2 Vision' },
]

const GEMINI: readonly AuthoredEntry[] = [
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
]

const AUTHORED: Record<ModelProviderId, readonly AuthoredEntry[]> = {
  'openai-compatible': [...OPENAI_CLOUD, ...LOCAL_OPENAI_WIRE],
  'anthropic-compatible': CLAUDE,
  'openai-subscription': OPENAI_CLOUD,
  'anthropic-subscription': CLAUDE,
  gemini: GEMINI,
}

function exposeCatalog(): Record<ModelProviderId, CatalogEntry[]> {
  return {
    'openai-compatible': AUTHORED['openai-compatible'].map(expose),
    'anthropic-compatible': AUTHORED['anthropic-compatible'].map(expose),
    'openai-subscription': AUTHORED['openai-subscription'].map(expose),
    'anthropic-subscription': AUTHORED['anthropic-subscription'].map(expose),
    gemini: AUTHORED.gemini.map(expose),
  }
}

export const MODEL_CATALOG: Record<ModelProviderId, CatalogEntry[]> = exposeCatalog()

export function getModelCatalog(): Record<ModelProviderId, CatalogEntry[]> {
  return {
    'openai-compatible': MODEL_CATALOG['openai-compatible'].map(entry => ({ ...entry })),
    'anthropic-compatible': MODEL_CATALOG['anthropic-compatible'].map(entry => ({ ...entry })),
    'openai-subscription': MODEL_CATALOG['openai-subscription'].map(entry => ({ ...entry })),
    'anthropic-subscription': MODEL_CATALOG['anthropic-subscription'].map(entry => ({ ...entry })),
    gemini: MODEL_CATALOG.gemini.map(entry => ({ ...entry })),
  }
}
