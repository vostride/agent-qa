import { z } from 'zod'

export interface ArtifactRef {
  id: string
  sha: string
  evidenceIncomplete?: boolean
}

export type EvidenceRefPrefix =
  | 'decision-screenshot:'
  | 'console-evidence:'
  | 'network-evidence:'
  | 'a11y-evidence:'
  | 'aria-state:'

export const EVIDENCE_REF_PREFIXES = [
  'decision-screenshot:',
  'console-evidence:',
  'network-evidence:',
  'a11y-evidence:',
  'aria-state:',
] as const satisfies readonly EvidenceRefPrefix[]

export const EvidenceArtifactRefSchema = z.strictObject({
  id: z.templateLiteral([z.enum(EVIDENCE_REF_PREFIXES), z.string()]),
  sha: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceIncomplete: z.boolean().optional(),
}).refine(ref => EVIDENCE_REF_PREFIXES.some(prefix => ref.id === `${prefix}${ref.sha}`), {
  error: 'Evidence ref id must contain its exact SHA and a known prefix',
})

export type EvidenceArtifactRef = z.infer<typeof EvidenceArtifactRefSchema>
