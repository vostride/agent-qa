import { expectTypeOf } from 'vitest'
import { DEFAULT_EMBEDDING_PROFILE } from '../index'
import type { EmbeddingProfile } from '../index'
import type { ModelProfile } from '../model-profile/index'

const base: EmbeddingProfile = {
  model_id: 'Xenova/bge-small-en-v1.5',
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  dim: 384,
  dtype: 'q8',
  pooling: 'mean',
  normalize: true,
  query_prefix: 'Represent this sentence for searching relevant passages: ',
  doc_prefix: '',
  backend: 'node',
  session_options: {},
  tau_dense: 0.38,
}

const defaultProfile: EmbeddingProfile = DEFAULT_EMBEDDING_PROFILE

expectTypeOf<keyof EmbeddingProfile>().toEqualTypeOf<
  | 'model_id'
  | 'revision'
  | 'dim'
  | 'dtype'
  | 'pooling'
  | 'normalize'
  | 'query_prefix'
  | 'doc_prefix'
  | 'backend'
  | 'session_options'
  | 'tau_dense'
>()

const nodeBackend: EmbeddingProfile = { ...base, backend: 'node' }
const staticBackend: EmbeddingProfile = { ...base, backend: 'static' }

// @ts-expect-error dtype is locked to the benchmarked q8 profile.
const badDtype: EmbeddingProfile = { ...base, dtype: 'fp32' }
// @ts-expect-error pooling is locked to mean pooling.
const badPooling: EmbeddingProfile = { ...base, pooling: 'cls' }
// @ts-expect-error the backend is `node` or `static`; `wasm` is not a backend.
const badBackendWasm: EmbeddingProfile = { ...base, backend: 'wasm' }
// @ts-expect-error backend rejects non-member literals.
const badBackendWebgpu: EmbeddingProfile = { ...base, backend: 'webgpu' }
// @ts-expect-error normalize is locked so cosine ranking matches dot-product ranking.
const badNormalize: EmbeddingProfile = { ...base, normalize: false }

// @ts-expect-error tau_dense is required: the admission floor reads it unconditionally.
const missingTauDense: EmbeddingProfile = (({ tau_dense, ...rest }) => rest)(base)
// @ts-expect-error revision is required: the embed cache and vec0 table identity key on it.
const missingRevision: EmbeddingProfile = (({ revision, ...rest }) => rest)(base)
// @ts-expect-error session_options is required — the runtime hands it to ORT verbatim.
const missingSessionOptions: EmbeddingProfile = (({ session_options, ...rest }) => rest)(base)

// @ts-expect-error a `threads` worker-count field is not part of the profile.
const withThreads: EmbeddingProfile = { ...base, threads: 1 }

expectTypeOf<EmbeddingProfile>().not.toHaveProperty('threads')
expectTypeOf<EmbeddingProfile>().not.toHaveProperty('provider')
expectTypeOf<EmbeddingProfile>().not.toHaveProperty('auth')
expectTypeOf<EmbeddingProfile>().not.toHaveProperty('capabilities')
expectTypeOf<ModelProfile>().not.toHaveProperty('model_id')
expectTypeOf<ModelProfile>().not.toHaveProperty('dim')

// @ts-expect-error EmbeddingProfile is structurally separate from chat ModelProfile.
const crossed: ModelProfile = base

void base
void defaultProfile
void nodeBackend
void staticBackend
void badDtype
void badPooling
void badBackendWasm
void badBackendWebgpu
void badNormalize
void missingTauDense
void missingRevision
void missingSessionOptions
void withThreads
void crossed
