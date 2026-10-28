import { resolve, sep } from 'node:path'

import type {
  FeatureExtractionPipeline,
  PretrainedModelOptions,
} from '@huggingface/transformers'
import type { EmbeddingProfile } from '@vostride/agent-qa-schema'

import type { EmbedderPort } from './embedder-port.js'
import { resolveModelCacheDir } from './model-cache-dir.js'

const nativePipelines = new Map<
  string,
  {
    maxTokens: number | undefined
    pipelinePromise: Promise<FeatureExtractionPipeline>
  }
>()
let nativePipelineLoadTail: Promise<void> = Promise.resolve()

export class NativeEmbeddingModuleLoadError extends Error {
  constructor(cause: unknown) {
    super('Native embedding module could not be loaded', { cause })
    this.name = 'NativeEmbeddingModuleLoadError'
  }
}

export class NativeEmbeddingDimensionError extends RangeError {
  readonly actualDim: number
  readonly expectedDim: number

  constructor(actualDim: number, expectedDim: number) {
    super(`Native embedding dimension ${actualDim} does not match profile dimension ${expectedDim}`)
    this.name = 'NativeEmbeddingDimensionError'
    this.actualDim = actualDim
    this.expectedDim = expectedDim
  }
}

function validateMaxTokens(maxTokens: number | undefined): number | undefined {
  if (maxTokens === undefined) return undefined
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new RangeError('maxTokens must be a positive safe integer')
  }
  return maxTokens
}

function pipelineKey(profile: EmbeddingProfile): string {
  return `${profile.model_id}@${profile.revision}:${profile.dtype}`
}

function tokenBudgetLabel(maxTokens: number | undefined): string {
  return maxTokens === undefined ? 'uncapped' : String(maxTokens)
}

function pinnedModelDirectory(cacheDir: string, profile: EmbeddingProfile): string {
  const root = resolve(cacheDir)
  const directory = resolve(root, profile.model_id, profile.revision)
  if (directory === root || !directory.startsWith(`${root}${sep}`)) {
    throw new TypeError(`${profile.model_id} cannot be resolved safely inside the model cache`)
  }
  return directory
}

function capTokenizer(extractor: FeatureExtractionPipeline, maxTokens: number): void {
  const tokenizer = extractor.tokenizer
  const tokenizerConfig = tokenizer._tokenizerConfig as
    | Record<string, unknown>
    | null
    | undefined
  const modelMaximum = Number(tokenizerConfig?.model_max_length)
  // Transformers v4's feature-extraction pipeline hard-codes truncation and reads this
  // getter-backed config value; some pinned tokenizers expose a null config, so initialize it.
  tokenizer._tokenizerConfig = {
    ...(tokenizerConfig ?? {}),
    model_max_length:
      Number.isSafeInteger(modelMaximum) && modelMaximum > 0
        ? Math.min(modelMaximum, maxTokens)
        : maxTokens,
  }
}

async function withNativePipelineLoadLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = nativePipelineLoadTail
  let release!: () => void
  nativePipelineLoadTail = new Promise<void>((resolvePending) => {
    release = resolvePending
  })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

async function loadPinnedPipeline(
  transformers: typeof import('@huggingface/transformers'),
  profile: EmbeddingProfile,
  allowDownload: boolean,
  maxTokens: number | undefined,
): Promise<FeatureExtractionPipeline> {
  return withNativePipelineLoadLock(async () => {
    const cacheDir = resolveModelCacheDir()
    transformers.env.cacheDir = cacheDir
    const sharedOptions = {
      cache_dir: cacheDir,
      local_files_only: !allowDownload,
      revision: profile.revision,
    }
    const modelSource = allowDownload
      ? profile.model_id
      : pinnedModelDirectory(cacheDir, profile)
    const originalRemotePathTemplate = transformers.env.remotePathTemplate
    const originalAllowRemoteModels = transformers.env.allowRemoteModels

    if (allowDownload) {
      // The tokenizer metadata probe (get_tokenizer_files) ignores the load options. Pin the
      // process-local URL template so even that probe addresses this exact revision.
      transformers.env.remotePathTemplate = `{model}/resolve/${encodeURIComponent(profile.revision)}/`
    } else {
      // The same metadata probe drops local_files_only. Loading from the exact local
      // revision directory with remote models disabled makes this path truly offline.
      transformers.env.allowRemoteModels = false
    }

    try {
      const [tokenizerResult, modelResult] = await Promise.allSettled([
        transformers.AutoTokenizer.from_pretrained(modelSource, sharedOptions),
        transformers.AutoModel.from_pretrained(modelSource, {
          ...sharedOptions,
          device: 'cpu',
          dtype: profile.dtype,
          session_options:
            profile.session_options as PretrainedModelOptions['session_options'],
        }),
      ])
      if (tokenizerResult.status === 'rejected') {
        if (modelResult.status === 'rejected') {
          // The option-dropping tokenizer metadata lookup can collapse an empty local
          // directory into a generic TypeError. The model loader keeps the actionable
          // local-files-only error, which the acquisition ladder classifies as a cold artifact.
          throw modelResult.reason
        }
        await modelResult.value.dispose().catch(() => undefined)
        throw tokenizerResult.reason
      }
      if (modelResult.status === 'rejected') throw modelResult.reason

      const tokenizer = tokenizerResult.value
      const model = modelResult.value
      try {
        const extractor = new transformers.FeatureExtractionPipeline({
          task: 'feature-extraction',
          model,
          tokenizer,
        })
        if (maxTokens !== undefined) capTokenizer(extractor, maxTokens)
        return extractor
      } catch (error) {
        await model.dispose().catch(() => undefined)
        throw error
      }
    } finally {
      transformers.env.remotePathTemplate = originalRemotePathTemplate
      transformers.env.allowRemoteModels = originalAllowRemoteModels
    }
  })
}

function acquirePipeline(
  profile: EmbeddingProfile,
  allowDownload: boolean,
  maxTokens: number | undefined,
): Promise<FeatureExtractionPipeline> {
  const key = pipelineKey(profile)
  const existing = nativePipelines.get(key)
  if (existing) {
    if (existing.maxTokens !== maxTokens) {
      throw new RangeError(
        `Native embedding pipeline budget conflict for ${key}: existing maxTokens=${tokenBudgetLabel(existing.maxTokens)}, requested maxTokens=${tokenBudgetLabel(maxTokens)}; one process-lifetime session per model identity permits only the first budget`,
      )
    }
    return existing.pipelinePromise
  }

  const pending = (async () => {
    let transformers: typeof import('@huggingface/transformers')
    try {
      transformers = await import('@huggingface/transformers')
    } catch (error) {
      throw new NativeEmbeddingModuleLoadError(error)
    }
    return loadPinnedPipeline(transformers, profile, allowDownload, maxTokens)
  })()

  nativePipelines.set(key, { maxTokens, pipelinePromise: pending })
  return pending
}

function toEmbedding(data: unknown, expectedDim: number): Float32Array {
  const vector =
    data instanceof Float32Array
      ? data
      : Float32Array.from(data as ArrayLike<number>)

  if (vector.length !== expectedDim) {
    throw new NativeEmbeddingDimensionError(vector.length, expectedDim)
  }

  return vector
}

export async function createNativeEmbedder(options: {
  profile: EmbeddingProfile
  allowDownload: boolean
  /** Optional process-wide token budget fixed by the first acquisition for this model identity. */
  maxTokens?: number
}): Promise<EmbedderPort> {
  const { profile, allowDownload } = options
  const maxTokens = validateMaxTokens(options.maxTokens)
  const extractor = await acquirePipeline(profile, allowDownload, maxTokens)

  async function embed(text: string, prefix: string): Promise<Float32Array> {
    const output = await extractor(`${prefix}${text}`, {
      pooling: 'mean',
      normalize: true,
    })

    return toEmbedding(output.data, profile.dim)
  }

  return {
    embedDocument: (rendering) => embed(rendering, profile.doc_prefix),
    embedQuery: (rendering) => embed(rendering, profile.query_prefix),
  }
}
