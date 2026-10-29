// This module imports nothing, so an import of it can sit on no cycle.

/** The identity a quarantine record is keyed on: `(product, filePath, testName)`, never `testId`. */
export interface QuarantineIdentity {
  product: string
  filePath: string
  testName: string
}

// `JSON.stringify` avoids separator collisions; changing it re-keys committed ledger history.
export function quarantineIdentityKey(identity: QuarantineIdentity): string {
  return JSON.stringify([identity.product, identity.filePath, identity.testName])
}
