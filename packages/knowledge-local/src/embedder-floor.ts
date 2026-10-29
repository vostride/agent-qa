import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Tokenizer } from '@huggingface/tokenizers'

import type { EmbedderPort } from './embedder-port.js'

const PACKAGE_NAME = '@vostride/agent-qa-knowledge-local'
const ASSET_DIRECTORY = 'potion-retrieval-32m'
const BINARY_FILE = 'potion-retrieval-32m.i8bin'
const TOKENIZER_FILE = 'tokenizer.json'
const GOLDEN_FILE = 'golden-vectors.json'
const MANIFEST_FILE = 'manifest.json'
const MODEL_ID = 'minishlab/potion-retrieval-32M'
const MODEL_REVISION = '6fc8051fab2a1e0ee76689cf08c853792ac285e7'
const FLOOR_MAGIC = 'PTNF'
const FLOOR_FORMAT_VERSION = 1
const FLOOR_VOCABULARY_SIZE = 63_091
const FLOOR_DIMENSION = 512
const FLOOR_HEADER_BYTES = 16
const MANIFEST_MAX_BYTES = 1024 * 1024
const TOKENIZER_MAX_BYTES = 16 * 1024 * 1024
const GOLDEN_MAX_BYTES = 8 * 1024 * 1024
const SHA256_RE = /^[0-9a-f]{64}$/u

export type FloorAssetLoadErrorCode =
  | 'package-root-not-found'
  | 'manifest-invalid'
  | 'asset-read-failed'
  | 'asset-size-mismatch'
  | 'digest-mismatch'
  | 'binary-invalid'
  | 'tokenizer-invalid'
  | 'tokenizer-runtime-unavailable'

export class FloorAssetLoadError extends Error {
  readonly code: FloorAssetLoadErrorCode

  constructor(code: FloorAssetLoadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FloorAssetLoadError'
    this.code = code
  }
}

export type FloorEmbeddingErrorCode =
  | 'empty-token-set'
  | 'token-id-out-of-range'
  | 'zero-vector'

export class FloorEmbeddingError extends Error {
  readonly code: FloorEmbeddingErrorCode

  constructor(code: FloorEmbeddingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FloorEmbeddingError'
    this.code = code
  }
}

interface ManifestFileEntry {
  bytes: number
  sha256: string
}

interface FloorManifest {
  modelId: string
  revision: string
  artifact: {
    magic: string
    version: number
    vocabularySize: number
    dimension: number
    quantization: string
  }
  files: Record<string, ManifestFileEntry>
}

export interface FloorAssets {
  tokenizer: Tokenizer
  vocabularySize: number
  dimension: number
  scales: Float32Array
  weights: Int8Array
}

export interface FloorAssetLoadOptions {
  /** Test-only injection seam. Production callers resolve the committed package asset. */
  assetsDir?: string
  /** Optional caller-owned token cap for bounded benchmark/runtime work. */
  maxTokens?: number
}

let memoizedDefaultAssets: Promise<FloorAssets> | undefined
let tokenizerRuntime: Promise<typeof import('@huggingface/tokenizers')> | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function packageRootFromImportMeta(): string {
  let current = dirname(fileURLToPath(import.meta.url))
  while (true) {
    const packageJsonPath = join(current, 'package.json')
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
        if (isRecord(packageJson) && packageJson.name === PACKAGE_NAME) return current
      } catch {
        // A parent package with unreadable metadata is not this package; continue upward.
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new FloorAssetLoadError(
    'package-root-not-found',
    `could not resolve ${PACKAGE_NAME} from ${fileURLToPath(import.meta.url)}`,
  )
}

function manifestEntry(value: unknown, file: string): ManifestFileEntry {
  if (!isRecord(value)) {
    throw new FloorAssetLoadError('manifest-invalid', `manifest files.${file} is invalid`)
  }
  if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) <= 0) {
    throw new FloorAssetLoadError(
      'manifest-invalid',
      `manifest files.${file}.bytes must be a positive safe integer`,
    )
  }
  if (typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)) {
    throw new FloorAssetLoadError(
      'manifest-invalid',
      `manifest files.${file}.sha256 must be a lowercase sha256 digest`,
    )
  }
  return { bytes: Number(value.bytes), sha256: value.sha256 }
}

function parseManifest(value: unknown): FloorManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.format !== 'potion-static-int8') {
    throw new FloorAssetLoadError('manifest-invalid', 'floor manifest identity is invalid')
  }
  if (value.modelId !== MODEL_ID || value.revision !== MODEL_REVISION) {
    throw new FloorAssetLoadError('manifest-invalid', 'floor manifest model pin is invalid')
  }
  if (!isRecord(value.artifact)) {
    throw new FloorAssetLoadError('manifest-invalid', 'floor manifest artifact is invalid')
  }
  const artifact = value.artifact
  if (
    artifact.magic !== FLOOR_MAGIC ||
    artifact.version !== FLOOR_FORMAT_VERSION ||
    artifact.vocabularySize !== FLOOR_VOCABULARY_SIZE ||
    artifact.dimension !== FLOOR_DIMENSION ||
    artifact.quantization !== 'symmetric-per-row-int8'
  ) {
    throw new FloorAssetLoadError('manifest-invalid', 'floor manifest artifact lock is invalid')
  }
  if (!isRecord(value.files)) {
    throw new FloorAssetLoadError('manifest-invalid', 'floor manifest files are invalid')
  }
  const manifestFiles = value.files
  const requiredFiles = [BINARY_FILE, TOKENIZER_FILE, GOLDEN_FILE] as const
  const fileNames = Object.keys(manifestFiles).sort()
  if (
    fileNames.length !== requiredFiles.length ||
    requiredFiles.some((file) => !fileNames.includes(file))
  ) {
    throw new FloorAssetLoadError(
      'manifest-invalid',
      'floor manifest must contain exactly the committed runtime payloads',
    )
  }
  return {
    modelId: MODEL_ID,
    revision: MODEL_REVISION,
    artifact: {
      magic: FLOOR_MAGIC,
      version: FLOOR_FORMAT_VERSION,
      vocabularySize: FLOOR_VOCABULARY_SIZE,
      dimension: FLOOR_DIMENSION,
      quantization: 'symmetric-per-row-int8',
    },
    files: Object.fromEntries(
      requiredFiles.map((file) => [file, manifestEntry(manifestFiles[file], file)]),
    ),
  }
}

function readManifest(assetsDir: string): FloorManifest {
  const path = join(assetsDir, MANIFEST_FILE)
  try {
    const size = statSync(path).size
    if (size <= 0 || size > MANIFEST_MAX_BYTES) {
      throw new FloorAssetLoadError(
        'manifest-invalid',
        `floor manifest byte length ${size} is outside the accepted range`,
      )
    }
    return parseManifest(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof FloorAssetLoadError) throw error
    throw new FloorAssetLoadError(
      'manifest-invalid',
      `could not read floor manifest: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

function expectedBinaryBytes(vocabularySize: number, dimension: number): number {
  const scalesBytes = vocabularySize * Float32Array.BYTES_PER_ELEMENT
  const weightsBytes = vocabularySize * dimension
  const total = FLOOR_HEADER_BYTES + scalesBytes + weightsBytes
  if (!Number.isSafeInteger(total)) {
    throw new FloorAssetLoadError('binary-invalid', 'floor binary length is not safe')
  }
  return total
}

function assertExpectedFileSize(
  assetsDir: string,
  file: string,
  entry: ManifestFileEntry,
  maximumBytes: number,
): void {
  let actualBytes: number
  try {
    actualBytes = statSync(join(assetsDir, file)).size
  } catch (error) {
    throw new FloorAssetLoadError(
      'asset-read-failed',
      `could not stat floor asset ${file}: ${errorMessage(error)}`,
      { cause: error },
    )
  }
  if (actualBytes !== entry.bytes || actualBytes <= 0 || actualBytes > maximumBytes) {
    throw new FloorAssetLoadError(
      'asset-size-mismatch',
      `floor asset ${file} has ${actualBytes} bytes; manifest declares ${entry.bytes}`,
    )
  }
}

function readAndVerifyFile(
  assetsDir: string,
  file: string,
  entry: ManifestFileEntry,
): Buffer {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(assetsDir, file))
  } catch (error) {
    throw new FloorAssetLoadError(
      'asset-read-failed',
      `could not read floor asset ${file}: ${errorMessage(error)}`,
      { cause: error },
    )
  }
  const actualDigest = createHash('sha256').update(bytes).digest('hex')
  if (actualDigest !== entry.sha256) {
    throw new FloorAssetLoadError(
      'digest-mismatch',
      `floor asset ${file} does not match its committed sha256`,
    )
  }
  return bytes
}

function parseBinary(bytes: Buffer): Omit<FloorAssets, 'tokenizer'> {
  if (bytes.byteLength < FLOOR_HEADER_BYTES) {
    throw new FloorAssetLoadError('binary-invalid', 'floor binary is shorter than its header')
  }
  const magic = bytes.toString('ascii', 0, 4)
  const version = bytes.readUInt32LE(4)
  const vocabularySize = bytes.readUInt32LE(8)
  const dimension = bytes.readUInt32LE(12)
  if (magic !== FLOOR_MAGIC || version !== FLOOR_FORMAT_VERSION) {
    throw new FloorAssetLoadError('binary-invalid', 'floor binary magic or version is invalid')
  }
  if (vocabularySize !== FLOOR_VOCABULARY_SIZE || dimension !== FLOOR_DIMENSION) {
    throw new FloorAssetLoadError('binary-invalid', 'floor binary dimensions are invalid')
  }
  if (bytes.byteLength !== expectedBinaryBytes(vocabularySize, dimension)) {
    throw new FloorAssetLoadError('binary-invalid', 'floor binary length is invalid')
  }

  const scales = new Float32Array(vocabularySize)
  for (let row = 0; row < vocabularySize; row += 1) {
    const scale = bytes.readFloatLE(FLOOR_HEADER_BYTES + row * Float32Array.BYTES_PER_ELEMENT)
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new FloorAssetLoadError('binary-invalid', `floor binary row ${row} has invalid scale`)
    }
    scales[row] = scale
  }

  const weightsOffset = FLOOR_HEADER_BYTES + vocabularySize * Float32Array.BYTES_PER_ELEMENT
  const weights = new Int8Array(
    bytes.buffer,
    bytes.byteOffset + weightsOffset,
    vocabularySize * dimension,
  )
  return { vocabularySize, dimension, scales, weights }
}

// the runtime package loads at the first acquisition, never at import, so a host that only
// reads never resolves it. A failed load is dropped so the next acquisition retries.
function loadTokenizerRuntime(): Promise<typeof import('@huggingface/tokenizers')> {
  tokenizerRuntime ??= import('@huggingface/tokenizers').catch((error: unknown) => {
    tokenizerRuntime = undefined
    throw new FloorAssetLoadError(
      'tokenizer-runtime-unavailable',
      `could not load the floor tokenizer runtime: ${errorMessage(error)}`,
      { cause: error },
    )
  })
  return tokenizerRuntime
}

async function parseTokenizer(bytes: Buffer): Promise<Tokenizer> {
  const { Tokenizer } = await loadTokenizerRuntime()
  try {
    const tokenizerJson: unknown = JSON.parse(bytes.toString('utf8'))
    if (!isRecord(tokenizerJson)) throw new TypeError('tokenizer.json must contain an object')
    return new Tokenizer(tokenizerJson, {})
  } catch (error) {
    throw new FloorAssetLoadError(
      'tokenizer-invalid',
      `could not construct floor tokenizer: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

async function loadFloorAssetsFrom(assetsDir: string): Promise<FloorAssets> {
  const manifest = readManifest(assetsDir)
  const binaryEntry = manifest.files[BINARY_FILE]!
  const tokenizerEntry = manifest.files[TOKENIZER_FILE]!
  const goldenEntry = manifest.files[GOLDEN_FILE]!
  const binaryExpectedBytes = expectedBinaryBytes(
    manifest.artifact.vocabularySize,
    manifest.artifact.dimension,
  )

  assertExpectedFileSize(assetsDir, BINARY_FILE, binaryEntry, binaryExpectedBytes)
  if (binaryEntry.bytes !== binaryExpectedBytes) {
    throw new FloorAssetLoadError(
      'asset-size-mismatch',
      `floor binary manifest length must be ${binaryExpectedBytes}`,
    )
  }
  assertExpectedFileSize(assetsDir, TOKENIZER_FILE, tokenizerEntry, TOKENIZER_MAX_BYTES)
  assertExpectedFileSize(assetsDir, GOLDEN_FILE, goldenEntry, GOLDEN_MAX_BYTES)

  const binaryBytes = readAndVerifyFile(assetsDir, BINARY_FILE, binaryEntry)
  const tokenizerBytes = readAndVerifyFile(assetsDir, TOKENIZER_FILE, tokenizerEntry)
  readAndVerifyFile(assetsDir, GOLDEN_FILE, goldenEntry)

  const binary = parseBinary(binaryBytes)
  return { ...binary, tokenizer: await parseTokenizer(tokenizerBytes) }
}

export function loadFloorAssets(options: FloorAssetLoadOptions = {}): Promise<FloorAssets> {
  if (options.assetsDir !== undefined) return loadFloorAssetsFrom(options.assetsDir)
  if (memoizedDefaultAssets !== undefined) return memoizedDefaultAssets
  const pending = (async () =>
    loadFloorAssetsFrom(join(packageRootFromImportMeta(), 'assets', ASSET_DIRECTORY)))()
  memoizedDefaultAssets = pending
  pending.catch(() => {
    if (memoizedDefaultAssets === pending) memoizedDefaultAssets = undefined
  })
  return pending
}

function embed(
  assets: FloorAssets,
  rendering: string,
  maxTokens: number | undefined,
): Float32Array {
  const encoded = assets.tokenizer.encode(rendering, { add_special_tokens: false }).ids
  const tokenIds = maxTokens === undefined ? encoded : encoded.slice(0, maxTokens)
  if (tokenIds.length === 0) {
    throw new FloorEmbeddingError(
      'empty-token-set',
      'floor tokenizer produced no tokens for the rendering',
    )
  }

  const means = new Float64Array(assets.dimension)
  for (const tokenId of tokenIds) {
    if (!Number.isSafeInteger(tokenId) || tokenId < 0 || tokenId >= assets.vocabularySize) {
      throw new FloorEmbeddingError(
        'token-id-out-of-range',
        `floor tokenizer produced out-of-range token id ${tokenId}`,
      )
    }
    const rowOffset = tokenId * assets.dimension
    const scale = assets.scales[tokenId]!
    for (let column = 0; column < assets.dimension; column += 1) {
      means[column] = means[column]! + assets.weights[rowOffset + column]! * scale
    }
  }

  let squaredLength = 0
  for (let column = 0; column < assets.dimension; column += 1) {
    const mean = means[column]! / tokenIds.length
    means[column] = mean
    squaredLength += mean * mean
  }
  const length = Math.sqrt(squaredLength)
  if (!Number.isFinite(length) || length === 0) {
    throw new FloorEmbeddingError('zero-vector', 'floor embedder produced a zero-length vector')
  }

  return Float32Array.from(means, (value) => value / length)
}

/**
 * Construct the pure-TypeScript degradation-floor embedder without loading assets eagerly.
 *
 * The static floor profile has empty document and query prefixes, so both legs intentionally
 * share exactly the same token lookup, mean pooling, and L2-normalization implementation.
 */
export function createFloorEmbedder(options: FloorAssetLoadOptions = {}): EmbedderPort {
  const maxTokens = options.maxTokens
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
    throw new RangeError('maxTokens must be a positive safe integer')
  }
  return {
    async embedDocument(rendering: string): Promise<Float32Array> {
      return embed(await loadFloorAssets(options), rendering, maxTokens)
    },
    async embedQuery(rendering: string): Promise<Float32Array> {
      return embed(await loadFloorAssets(options), rendering, maxTokens)
    },
  }
}
