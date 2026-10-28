export interface ApprovedSaasPlaceholder {
  readonly name: string
  readonly slug: string
}

export const APPROVED_SAAS_PLACEHOLDERS = [
  { name: 'Linear', slug: 'linear' },
  { name: 'Vercel', slug: 'vercel' },
  { name: 'Notion', slug: 'notion' },
  { name: 'Stripe', slug: 'stripe' },
  { name: 'GitHub', slug: 'github' },
  { name: 'Slack', slug: 'slack' },
  { name: 'Figma', slug: 'figma' },
  { name: 'Shopify', slug: 'shopify' },
  { name: 'Datadog', slug: 'datadog' },
  { name: 'Supabase', slug: 'supabase' },
] as const satisfies readonly ApprovedSaasPlaceholder[]

export const APPROVED_SAAS_PLACEHOLDER_NAMES = APPROVED_SAAS_PLACEHOLDERS.map((item) => item.name)
export const APPROVED_SAAS_PLACEHOLDER_SLUGS = APPROVED_SAAS_PLACEHOLDERS.map((item) => item.slug)

function hashSeed(seed: string | number): number {
  const input = String(seed)
  let hash = 0

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0
  }

  return hash
}

export function selectApprovedSaasPlaceholder(seed: string | number): ApprovedSaasPlaceholder {
  return APPROVED_SAAS_PLACEHOLDERS[hashSeed(seed) % APPROVED_SAAS_PLACEHOLDERS.length]
}

export function selectApprovedSaasPlaceholderSlug(seed: string | number): string {
  return selectApprovedSaasPlaceholder(seed).slug
}
