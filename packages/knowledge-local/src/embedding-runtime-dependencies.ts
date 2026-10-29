import type { Tokenizer } from '@huggingface/tokenizers'
import type { pipeline } from '@huggingface/transformers'

// Erased aliases: importing them loads neither runtime.
export type FloorEmbeddingTokenizer = Tokenizer
export type NativeEmbeddingPipelineFactory = typeof pipeline
