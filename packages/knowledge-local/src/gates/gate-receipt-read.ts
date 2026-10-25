// Reads only. This answer derives from committed receipt history and the pure gate.
// Absence is a row; unreadable data still throws.
import { asRecordId, evaluatePromotionGate, isPromotionReceipt, KnowledgeGatesListResultSchema,
  standingReceiptsByGate, strongestPromotionPath,
  type GateReceipt, type KnowledgeGatesListResult } from '@vostride/agent-qa-schema'
import { deriveBundleTrust, readGateReceipts } from '../bundle-read.js'
import { enumerateMaintenanceBundleDirs, loadMaintenanceBundle } from '../maintenance-scan.js'
import { assemblePromotionGateInput } from '../promotion-gate-input.js'

export interface GateReceiptsForOptions {
  knowledgeRoot: string
  candidateId: string
}
export function gateReceiptsFor(options: GateReceiptsForOptions): KnowledgeGatesListResult {
  const id = asRecordId(options.candidateId)
  for (const entry of enumerateMaintenanceBundleDirs(options.knowledgeRoot)) {
    const bundle = loadMaintenanceBundle(entry)
    if (bundle.manifest.id !== id) continue
    const lines = readGateReceipts(entry.dir, id) ?? []
    const standing = standingReceiptsByGate(
      lines.filter((line): line is GateReceipt => !isPromotionReceipt(line)),
    )
    const path = strongestPromotionPath(lines)
    const gateInput = assemblePromotionGateInput({
      knowledgeRoot: options.knowledgeRoot, bundleDir: entry.dir, bundle,
    })
    return KnowledgeGatesListResultSchema.parse({
      kind: 'found', recordId: id, product: entry.product,
      recordKind: bundle.frontmatter.kind, status: deriveBundleTrust(bundle).status,
      ...(path === undefined ? {} : { strongestPromotionPath: path }),
      lines, standing,
      live: evaluatePromotionGate(gateInput),
    })
  }
  return { kind: 'not-found', recordId: options.candidateId }
}
