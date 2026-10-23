import type { JsonObject } from '../run/run-artifact'

export interface EmbeddingProfile {
  /** Embedding model id selected by the memidex profile. */
  model_id: string
  /**
   * Model revision pinned for index identity.
   *
   * Phase 376's embed cache is keyed (model_id, dtype, revision,
   * sha256(rendering)) and the per-model vec0 table identity includes it.
   * Locked production profiles use the exact commit hash exercised by the
   * embedding bench so upstream re-uploads cannot change index identity.
   */
  revision: string
  /** Output vector dimensionality for the selected model. */
  dim: number
  /** Quantized weight format locked by the benchmarked default. */
  dtype: 'q8'
  /** Token-to-sentence pooling locked by the benchmarked default. */
  pooling: 'mean'
  /** L2 normalization stays locked so cosine ranking matches dot-product ranking. */
  normalize: true
  /**
   * Text prepended to query inputs before embedding.
   *
   * BGE-family models require the asymmetric instruction on the query side
   * only; documents are embedded raw. Symmetric alternates (e.g.
   * gte-modernbert-base) set both prefixes empty, so a model swap stays
   * purely declarative.
   */
  query_prefix: string
  /**
   * Text prepended to document inputs before embedding.
   *
   * Symmetric models use an empty prefix. BGE-family models embed documents
   * raw, so this remains an empty string while query_prefix carries the
   * query-side instruction.
   */
  doc_prefix: string
  /**
   * Execution backend.
   *
   * 'node' is the onnxruntime-node native CPU path (transformers.js v4's
   * default device in Node). 'static' is the bundled potion-retrieval-32M
   * pure-TS floor profile; only the vocabulary ships now — its runtime
   * arrives with Phase 376.
   */
  backend: 'node' | 'static'
  /**
   * ORT session tuning passed through verbatim by the embedding runtime.
   *
   * Loose JSON by design: schema is host-API-free and never imports
   * onnxruntime types; knowledge-local hands this object to ORT unchanged.
   */
  session_options: JsonObject
  /**
   * Per-leg dense admission floor for this model.
   *
   * Each profile's value is calibrated from the recorded gold-pair cosine
   * distribution. The value may change after a benchmark gate, but the
   * required profile-owned shape stays fixed for every retrieval consumer.
   */
  tau_dense: number
}

export const DEFAULT_EMBEDDING_PROFILE = {
  model_id: 'Xenova/bge-small-en-v1.5',
  /**
   * Locked 2026-07-14 from the embedding benchmark (D-07).
   * This pin changes vec-table identity; old revision-keyed tables are
   * disposable rebuildable projections and are rebuilt, never migrated.
   */
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  dim: 384,
  dtype: 'q8',
  pooling: 'mean',
  normalize: true,
  query_prefix: 'Represent this sentence for searching relevant passages: ',
  doc_prefix: '',
  backend: 'node',
  session_options: {
    intraOpNumThreads: 2,
    extra: {
      session: { intra_op: { allow_spinning: '0' } },
      optimization: { enable_gelu_approximation: '1' },
    },
  },
  /**
   * Locked 2026-07-14 from the embedding benchmark's recorded gold-pair p05 0.385200;
   * rounded down to two decimals.
   */
  tau_dense: 0.38,
} as const satisfies EmbeddingProfile

/**
 * Bundled pure-TypeScript degradation floor (D-12/D-13).
 *
 * A floor that must be fetched isn't a floor — the hosts that need it are
 * exactly the hosts that can't download it.
 */
export const STATIC_FLOOR_EMBEDDING_PROFILE = {
  model_id: 'minishlab/potion-retrieval-32M',
  revision: '6fc8051fab2a1e0ee76689cf08c853792ac285e7',
  dim: 512,
  dtype: 'q8',
  pooling: 'mean',
  normalize: true,
  query_prefix: '',
  doc_prefix: '',
  backend: 'static',
  /** ORT session options are inert for the static backend. */
  session_options: {},
  /**
   * Locked 2026-07-14 from the embedding benchmark's recorded gold-pair p05 -0.012736;
   * rounded down to two decimals.
   */
  tau_dense: -0.02,
} as const satisfies EmbeddingProfile
