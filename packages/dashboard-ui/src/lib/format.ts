const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function formatTokens(n: number): string {
  return compactFormatter.format(n)
}
