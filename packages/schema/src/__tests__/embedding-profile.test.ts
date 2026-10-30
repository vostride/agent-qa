import { describe, expect, it } from 'vitest'
import { DEFAULT_EMBEDDING_PROFILE, STATIC_FLOOR_EMBEDDING_PROFILE } from '../index'

describe('DEFAULT_EMBEDDING_PROFILE', () => {
  it('pins the ratified embedding default lock', () => {
    expect(DEFAULT_EMBEDDING_PROFILE).toEqual({
      model_id: 'Xenova/bge-small-en-v1.5',
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
      tau_dense: 0.38,
    })
  })

  it('pins the exact BGE query prefix on the query side only', () => {
    expect(DEFAULT_EMBEDDING_PROFILE.query_prefix).toBe(
      'Represent this sentence for searching relevant passages: ',
    )
    expect(DEFAULT_EMBEDDING_PROFILE.doc_prefix).toBe('')
  })

  it('pins the spec-verbatim nested session_options object', () => {
    expect(DEFAULT_EMBEDDING_PROFILE.session_options).toEqual({
      intraOpNumThreads: 2,
      extra: {
        session: { intra_op: { allow_spinning: '0' } },
        optimization: { enable_gelu_approximation: '1' },
      },
    })
  })

  it('pins the bench-calibrated tau_dense admission floor', () => {
    expect(DEFAULT_EMBEDDING_PROFILE.tau_dense).toBe(0.38)
  })
})

describe('STATIC_FLOOR_EMBEDDING_PROFILE', () => {
  it('pins the bundled potion retrieval floor', () => {
    expect(STATIC_FLOOR_EMBEDDING_PROFILE).toEqual({
      model_id: 'minishlab/potion-retrieval-32M',
      revision: '6fc8051fab2a1e0ee76689cf08c853792ac285e7',
      dim: 512,
      dtype: 'q8',
      pooling: 'mean',
      normalize: true,
      query_prefix: '',
      doc_prefix: '',
      backend: 'static',
      session_options: {},
      tau_dense: -0.02,
    })
  })

  it('has an embedding identity distinct from the native default', () => {
    expect({
      model_id: STATIC_FLOOR_EMBEDDING_PROFILE.model_id,
      revision: STATIC_FLOOR_EMBEDDING_PROFILE.revision,
      dtype: STATIC_FLOOR_EMBEDDING_PROFILE.dtype,
      dim: STATIC_FLOOR_EMBEDDING_PROFILE.dim,
    }).not.toEqual({
      model_id: DEFAULT_EMBEDDING_PROFILE.model_id,
      revision: DEFAULT_EMBEDDING_PROFILE.revision,
      dtype: DEFAULT_EMBEDDING_PROFILE.dtype,
      dim: DEFAULT_EMBEDDING_PROFILE.dim,
    })
  })
})
