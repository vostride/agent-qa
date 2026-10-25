import {
  isPromotionReceipt, standingReceiptsByGate, type GateReceipt,
} from '@vostride/agent-qa-schema'
import { readGateReceipts } from '../bundle-read.js'
import { enumerateMaintenanceBundleDirs, loadMaintenanceBundle } from '../maintenance-scan.js'

export interface StandingReceiptDigest {
  candidateId: string
  gate: GateReceipt['gate']
  verdict: GateReceipt['verdict']
  /** Gate 3 is user evidence and has no corpus citation. */
  corpusDigest?: string
  producedAtOrdinal: number
}

export function standingReceiptDigestsFor(input: { knowledgeRoot: string }): StandingReceiptDigest[] {
  // The strict maintenance walk throws on a bundle it cannot load or verify instead of skipping it.
  return enumerateMaintenanceBundleDirs(input.knowledgeRoot).flatMap(entry => {
    const bundle = loadMaintenanceBundle(entry)
    const lines = readGateReceipts(entry.dir, bundle.manifest.id) ?? []
    return standingReceiptsByGate(
      lines.filter((line): line is GateReceipt => !isPromotionReceipt(line)),
    ).map(receipt => ({
      candidateId: receipt.candidateId, gate: receipt.gate, verdict: receipt.verdict,
      ...('corpusVersion' in receipt ? { corpusDigest: receipt.corpusVersion.corpusDigest } : {}),
      producedAtOrdinal: receipt.producedAtOrdinal,
    }))
  })
}
