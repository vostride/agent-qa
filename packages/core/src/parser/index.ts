export { parseTestFile, parseAllTests } from './yaml-parser.js'
export type { ParseResult } from './yaml-parser.js'
export { formatParseError } from './errors.js'
export type { ParseError } from './errors.js'
export { resolveFileReferences } from './file-resolver.js'
export type { FileAttachment } from './file-resolver.js'
export { parseSuiteFile } from './suite-parser.js'

// The CST edit path, beside `parseTestFile`, which discards the token array it needs.
export {
  applyPatchSetToTestDoc,
  parseTestFileWithTokens,
  renderPatchedTestDoc,
  PatchedDocumentInvalidError,
  PatchOpUnsupportedTargetError,
  PatchPointerOutsideEditableRegionError,
  PatchPointerUnresolvableError,
} from './cst-patch.js'
export type { ParsedTestDocument } from './cst-patch.js'
