export { parseTestFile, parseAllTests } from './yaml-parser.js'
export type { ParseResult } from './yaml-parser.js'
export { formatParseError } from './errors.js'
export type { ParseError } from './errors.js'
export { resolveFileReferences } from './file-resolver.js'
export type { FileAttachment } from './file-resolver.js'
export { parseSuiteFile } from './suite-parser.js'

// 394: the CST-level RFC-6902 edit path. A sibling of `parseTestFile`, never a
// replacement — the edit path needs the token array `parseTestFile` discards.
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
