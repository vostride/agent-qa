// `r_phasis-label-purple-ligne` → `r_phasis-label`: what comes before the third hyphenated word.
export function shortRunId(runId: string): string {
  const words = runId.split('-')
  return words.length < 3 ? runId : words.slice(0, 2).join('-')
}
