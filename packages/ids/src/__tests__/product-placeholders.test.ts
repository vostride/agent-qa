import { describe, expect, it } from 'vitest'
import {
  APPROVED_SAAS_PLACEHOLDERS,
  APPROVED_SAAS_PLACEHOLDER_NAMES,
  APPROVED_SAAS_PLACEHOLDER_SLUGS,
  selectApprovedSaasPlaceholder,
  selectApprovedSaasPlaceholderSlug,
} from '../product-placeholders.js'

const EXPECTED_NAMES = ['Linear', 'Vercel', 'Notion', 'Stripe', 'GitHub', 'Slack', 'Figma', 'Shopify', 'Datadog', 'Supabase']
const EXPECTED_SLUGS = ['linear', 'vercel', 'notion', 'stripe', 'github', 'slack', 'figma', 'shopify', 'datadog', 'supabase']

describe('product placeholder contract', () => {
  it('exposes the approved top-tier SaaS placeholders', () => {
    expect([...APPROVED_SAAS_PLACEHOLDER_NAMES]).toEqual(EXPECTED_NAMES)
    expect([...APPROVED_SAAS_PLACEHOLDER_SLUGS]).toEqual(EXPECTED_SLUGS)
    expect(APPROVED_SAAS_PLACEHOLDERS.map((item) => item.name)).toEqual(EXPECTED_NAMES)
    expect(APPROVED_SAAS_PLACEHOLDERS.map((item) => item.slug)).toEqual(EXPECTED_SLUGS)
  })

  it('keeps placeholder names and slugs unique', () => {
    expect(new Set(APPROVED_SAAS_PLACEHOLDER_NAMES).size).toBe(10)
    expect(new Set(APPROVED_SAAS_PLACEHOLDER_SLUGS).size).toBe(10)
  })

  it('selects placeholders deterministically by seed', () => {
    const first = selectApprovedSaasPlaceholder('dashboard.config.targets.product')
    const second = selectApprovedSaasPlaceholder('dashboard.config.targets.product')

    expect(first).toEqual(second)
  })

  it('selects slug placeholders from the approved slug list', () => {
    const slug = selectApprovedSaasPlaceholderSlug('registry.targets.product')

    expect(EXPECTED_SLUGS).toContain(slug)
  })
})
