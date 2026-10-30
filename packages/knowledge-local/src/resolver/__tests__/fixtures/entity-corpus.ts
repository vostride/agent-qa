// Vectors are declared, not measured: entity = 0.5 * family + (sqrt(3)/2) * own.

import type { EntityKind } from '@vostride/agent-qa-schema'

/** sqrt(3)/2 — the own-axis weight that makes `0.5 * family + this * own` a unit vector. */
export const OWN_AXIS_WEIGHT = 0.8660254037844386

/** The family axis weight. Squared (0.25) it is what a sibling scores, deliberately below tau. */
export const FAMILY_AXIS_WEIGHT = 0.5

export interface CorpusEntity {
  readonly kind: EntityKind
  /** The owning store's id. Also this entity's own semantic axis. */
  readonly machineId: string
  readonly title: string
  /** The semantic family this entity belongs to; its axis is shared with its siblings. */
  readonly family: string
  readonly statusSource?: string
}

/**
 * The population.
 *
 * Ordered, because the addressing ledger mints on first sighting and the harness sights this
 * array front to back — so an entity's ordinal is its position among its own kind here, and a
 * short-ID in an expectation below is a fact about this list rather than about a run.
 *
 * All five mintable kinds are present in the population.
 */
export const CORPUS_ENTITIES: readonly CorpusEntity[] = [
  // ---- TST: the checkout family (near-twins by design) ----
  { kind: 'TST', machineId: 'checkout-happy-path', title: 'Checkout happy path with a saved card', family: 'fam-checkout' },
  { kind: 'TST', machineId: 'checkout-guest-path', title: 'Checkout guest path without an account', family: 'fam-checkout' },
  { kind: 'TST', machineId: 'checkout-expired-card', title: 'Checkout declines an expired card', family: 'fam-checkout' },
  { kind: 'TST', machineId: 'checkout-coupon-code', title: 'Checkout applies a coupon code', family: 'fam-checkout' },
  { kind: 'TST', machineId: 'checkout-address-validation', title: 'Checkout validates the delivery address', family: 'fam-checkout' },
  { kind: 'TST', machineId: 'checkout-tax-rounding', title: 'Checkout rounds tax to two decimals', family: 'fam-checkout' },
  { kind: 'TST', machineId: 'checkout-empty-basket', title: 'Checkout refuses an empty basket', family: 'fam-checkout' },
  { kind: 'TST', machineId: 'checkout-double-submit', title: 'Checkout ignores a double submit', family: 'fam-checkout' },

  // ---- TST: sign in ----
  { kind: 'TST', machineId: 'signin-stored-password', title: 'Sign in with a stored password', family: 'fam-signin' },
  { kind: 'TST', machineId: 'signin-magic-link', title: 'Sign in through a magic link', family: 'fam-signin' },
  { kind: 'TST', machineId: 'signin-lockout', title: 'Sign in locks out after five failures', family: 'fam-signin' },
  { kind: 'TST', machineId: 'signin-google-idp', title: 'Sign in through the Google identity provider', family: 'fam-signin' },
  { kind: 'TST', machineId: 'signin-remember-browser', title: 'Sign in remembers this browser', family: 'fam-signin' },
  { kind: 'TST', machineId: 'signin-forgotten-password', title: 'Reset a forgotten password', family: 'fam-signin' },
  { kind: 'TST', machineId: 'signin-idle-expiry', title: 'Session expires when idle', family: 'fam-signin' },

  // ---- TST: basket ----
  { kind: 'TST', machineId: 'basket-add-item', title: 'Add an item to the basket', family: 'fam-basket' },
  { kind: 'TST', machineId: 'basket-remove-item', title: 'Remove an item from the basket', family: 'fam-basket' },
  { kind: 'TST', machineId: 'basket-quantity-limit', title: 'Basket enforces a quantity limit', family: 'fam-basket' },
  { kind: 'TST', machineId: 'basket-across-devices', title: 'Basket persists across devices', family: 'fam-basket' },
  { kind: 'TST', machineId: 'basket-merge-on-signin', title: 'Basket merges when a shopper signs in', family: 'fam-basket' },
  { kind: 'TST', machineId: 'basket-stale-prices', title: 'Basket refreshes stale prices', family: 'fam-basket' },

  // ---- TST: payment ----
  { kind: 'TST', machineId: 'payment-3ds-challenge', title: 'Card payment completes a 3ds challenge', family: 'fam-payment' },
  { kind: 'TST', machineId: 'payment-apple-wallet', title: 'Wallet payment through Apple', family: 'fam-payment' },
  { kind: 'TST', machineId: 'payment-partial-refund', title: 'Partial refund returns the difference', family: 'fam-payment' },
  { kind: 'TST', machineId: 'payment-declined-retry', title: 'Declined payment retries once', family: 'fam-payment' },
  { kind: 'TST', machineId: 'payment-currency-switch', title: 'Payment switches currency at the border', family: 'fam-payment' },
  { kind: 'TST', machineId: 'payment-idempotency-key', title: 'Payment honours an idempotency key', family: 'fam-payment' },

  // ---- TST: catalogue search ----
  { kind: 'TST', machineId: 'catalogue-typeahead', title: 'Typeahead suggests products while typing', family: 'fam-catalogue' },
  { kind: 'TST', machineId: 'catalogue-empty-state', title: 'Catalogue shows an empty state', family: 'fam-catalogue' },
  { kind: 'TST', machineId: 'catalogue-facet-filter', title: 'Catalogue filters by facet', family: 'fam-catalogue' },
  { kind: 'TST', machineId: 'catalogue-price-sort', title: 'Catalogue sorts by price', family: 'fam-catalogue' },
  { kind: 'TST', machineId: 'catalogue-synonym-map', title: 'Catalogue maps a synonym onto a product', family: 'fam-catalogue' },

  // ---- TST: account ----
  { kind: 'TST', machineId: 'account-change-email', title: 'Change the account email', family: 'fam-account' },
  { kind: 'TST', machineId: 'account-erasure', title: 'Erase the account and everything it holds', family: 'fam-account' },
  { kind: 'TST', machineId: 'account-address-book', title: 'Manage the address book', family: 'fam-account' },
  { kind: 'TST', machineId: 'account-notification-prefs', title: 'Manage notification preferences', family: 'fam-account' },

  // ---- TST: the rare-vocabulary singletons and twin pairs ----
  { kind: 'TST', machineId: 'oversell-guard', title: 'Oversell guard holds the last unit', family: 'fam-warehouse' },
  { kind: 'TST', machineId: 'parcel-rate-quote', title: 'Parcel rate quote for a heavy consignment', family: 'fam-warehouse' },
  { kind: 'TST', machineId: 'quarantine-flake-triage', title: 'Quarantine triage for a flaky spec', family: 'fam-quarantine' },
  { kind: 'TST', machineId: 'quarantine-flake-report', title: 'Quarantine report for a flaky spec', family: 'fam-quarantine' },
  { kind: 'TST', machineId: 'zephyr-latency-probe', title: 'Latency probe against the zephyr gateway', family: 'fam-zephyr' },
  { kind: 'TST', machineId: 'zephyr-latency-audit', title: 'Latency audit against the zephyr gateway', family: 'fam-zephyr' },

  // ---- RUN ----
  { kind: 'RUN', machineId: 'r_nightly_checkout', title: 'Nightly regression over the checkout suite', family: 'fam-schedule', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_smoke_signin', title: 'Smoke sweep over the sign in suite', family: 'fam-schedule', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_release_gate_v41', title: 'Release gate for the v41 build', family: 'fam-schedule', statusSource: 'failed' },
  { kind: 'RUN', machineId: 'r_hotfix_verify', title: 'Hotfix verification after the payment outage', family: 'fam-schedule', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_canary_frankfurt_dawn', title: 'Canary sweep over the frankfurt region at dawn', family: 'fam-canary', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_canary_frankfurt_dusk', title: 'Canary sweep over the frankfurt region at dusk', family: 'fam-canary', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_soak_weekend', title: 'Weekend soak against the staging estate', family: 'fam-schedule', statusSource: 'running' },
  { kind: 'RUN', machineId: 'r_perf_budget', title: 'Performance budget sweep on mobile hardware', family: 'fam-perf', statusSource: 'failed' },
  { kind: 'RUN', machineId: 'r_perf_cold_start', title: 'Cold start timing on a throttled cpu', family: 'fam-perf', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_accessibility_audit', title: 'Accessibility audit across every storefront page', family: 'fam-audit', statusSource: 'failed' },
  { kind: 'RUN', machineId: 'r_locale_matrix', title: 'Locale matrix across nine languages', family: 'fam-audit', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_pilot_beta_cohort', title: 'Pilot exercise with the beta cohort', family: 'fam-pilot', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_pilot_dogfood', title: 'Pilot exercise inside the dogfood estate', family: 'fam-pilot', statusSource: 'running' },
  { kind: 'RUN', machineId: 'r_upgrade_rehearsal', title: 'Upgrade rehearsal on a restored snapshot', family: 'fam-migration', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_rollback_drill', title: 'Rollback drill from the previous manifest', family: 'fam-migration', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_chaos_latency', title: 'Chaos exercise injecting network delay', family: 'fam-chaos', statusSource: 'failed' },
  { kind: 'RUN', machineId: 'r_chaos_disk_full', title: 'Chaos exercise filling the scratch volume', family: 'fam-chaos', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_security_sweep', title: 'Security sweep over exposed endpoints', family: 'fam-audit', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_visual_baseline', title: 'Visual baseline refresh for every viewport', family: 'fam-visual', statusSource: 'passed' },
  { kind: 'RUN', machineId: 'r_visual_diff_review', title: 'Visual difference review before publishing', family: 'fam-visual', statusSource: 'running' },

  // ---- MEM ----
  { kind: 'MEM', machineId: 'mem_checkout_button_moved', title: 'The checkout button moved into the footer', family: 'fam-checkout' },
  { kind: 'MEM', machineId: 'mem_signin_captcha_added', title: 'A captcha now guards the sign in form', family: 'fam-signin' },
  { kind: 'MEM', machineId: 'mem_basket_badge_debounce', title: 'The basket badge debounces its counter', family: 'fam-basket' },
  { kind: 'MEM', machineId: 'mem_payment_sandbox_flaky', title: 'The payment sandbox is flaky before noon', family: 'fam-payment' },
  { kind: 'MEM', machineId: 'mem_pagination_offset', title: 'Pagination hands back an offset token', family: 'fam-pagination' },
  { kind: 'MEM', machineId: 'mem_pagination_cursor', title: 'Pagination hands back a cursor token', family: 'fam-pagination' },
  { kind: 'MEM', machineId: 'mem_locale_decimal_comma', title: 'Some locales render a decimal comma', family: 'fam-locale' },
  { kind: 'MEM', machineId: 'mem_locale_rtl_mirror', title: 'Right to left locales mirror the layout', family: 'fam-locale' },
  { kind: 'MEM', machineId: 'mem_cdn_cache_purge', title: 'The edge cache needs a purge after publishing', family: 'fam-infra' },
  { kind: 'MEM', machineId: 'mem_staging_seed_drift', title: 'Staging seed data drifts every fortnight', family: 'fam-infra' },
  { kind: 'MEM', machineId: 'mem_toast_autoclose', title: 'Toast notifications close themselves too quickly', family: 'fam-ui' },
  { kind: 'MEM', machineId: 'mem_modal_focus_trap', title: 'The modal keeps focus inside itself', family: 'fam-ui' },
  { kind: 'MEM', machineId: 'mem_flaky_clock_skew', title: 'Clock skew makes expiry assertions flaky', family: 'fam-flake' },
  { kind: 'MEM', machineId: 'mem_flaky_animation_wait', title: 'Animation waits make assertions flaky', family: 'fam-flake' },
  { kind: 'MEM', machineId: 'mem_catalogue_stopwords', title: 'The catalogue index drops very short words', family: 'fam-catalogue' },
  { kind: 'MEM', machineId: 'mem_warehouse_backorder', title: 'Backorder quantities appear as negative stock', family: 'fam-warehouse' },
  { kind: 'MEM', machineId: 'mem_account_email_case', title: 'Account email comparison ignores capitals', family: 'fam-account' },
  { kind: 'MEM', machineId: 'mem_perf_p95_regression', title: 'The p95 budget regressed on the product page', family: 'fam-perf' },
  { kind: 'MEM', machineId: 'mem_migration_dual_write', title: 'The migration writes into both schemas', family: 'fam-migration' },
  { kind: 'MEM', machineId: 'mem_zephyr_retry_storm', title: 'The zephyr gateway answers slowly under a retry storm', family: 'fam-zephyr' },

  // ---- POL ----
  { kind: 'POL', machineId: 'pol_never_reuse_credential', title: 'Never reuse a credential between environments', family: 'fam-secrets' },
  { kind: 'POL', machineId: 'pol_secret_rotation_ninety', title: 'Rotate the deploy secret every ninety days', family: 'fam-secrets' },
  { kind: 'POL', machineId: 'pol_secret_rotation_thirty', title: 'Rotate the deploy secret every thirty days', family: 'fam-secrets' },
  { kind: 'POL', machineId: 'pol_no_production_writes', title: 'Suites never write into production', family: 'fam-safety' },
  { kind: 'POL', machineId: 'pol_isolate_after_three', title: 'Isolate a suite after three consecutive failures', family: 'fam-safety' },
  { kind: 'POL', machineId: 'pol_screenshot_redaction', title: 'Redact personal data out of every screenshot', family: 'fam-privacy' },
  { kind: 'POL', machineId: 'pol_retain_artifacts_ninety', title: 'Retain artifacts for ninety days then prune', family: 'fam-privacy' },
  { kind: 'POL', machineId: 'pol_review_before_merge', title: 'Every change is reviewed before merging', family: 'fam-process' },
  { kind: 'POL', machineId: 'pol_no_silent_skip', title: 'A skipped assertion is reported, never hidden', family: 'fam-process' },
  { kind: 'POL', machineId: 'pol_budget_ci_minutes', title: 'Keep continuous integration minutes inside the budget', family: 'fam-process' },
  { kind: 'POL', machineId: 'pol_locale_source_of_truth', title: 'Translations come from one source of truth', family: 'fam-locale' },
  { kind: 'POL', machineId: 'pol_deprecate_with_notice', title: 'Deprecate an interface only with prior notice', family: 'fam-process' },

  // ---- TGT (slug addressed) ----
  { kind: 'TGT', machineId: 'checkout-web', title: 'Checkout web storefront', family: 'fam-checkout' },
  { kind: 'TGT', machineId: 'admin-console', title: 'Administrative console', family: 'fam-internal' },
  { kind: 'TGT', machineId: 'partner-portal', title: 'Partner portal', family: 'fam-internal' },
  { kind: 'TGT', machineId: 'mobile-android', title: 'Android shopping application', family: 'fam-mobile' },
  { kind: 'TGT', machineId: 'mobile-ios', title: 'Apple shopping application', family: 'fam-mobile' },
  { kind: 'TGT', machineId: 'public-api', title: 'Public programmable interface', family: 'fam-internal' },
  { kind: 'TGT', machineId: 'warehouse-console', title: 'Warehouse operator console', family: 'fam-warehouse' },
  { kind: 'TGT', machineId: 'zephyr-gateway', title: 'Zephyr payment gateway', family: 'fam-zephyr' },
  { kind: 'TGT', machineId: 'marketing-site', title: 'Marketing brochure site', family: 'fam-marketing' },
  { kind: 'TGT', machineId: 'status-page', title: 'Public status page', family: 'fam-marketing' },
  { kind: 'TGT', machineId: 'support-desk', title: 'Support desk workspace', family: 'fam-internal' },
  { kind: 'TGT', machineId: 'analytics-warehouse', title: 'Analytics warehouse', family: 'fam-warehouse' },
]

/** The five locked query-case categories. */
export const CORPUS_CATEGORIES = [
  'exact',
  'typo',
  'semantic',
  'near-twin',
  'miss',
] as const

export type CorpusCategory = (typeof CORPUS_CATEGORIES)[number]

/** How a case addresses the corpus. `text` is free text; the rest are tier-(a) address forms. */
export type CorpusRef =
  | { readonly form: 'text'; readonly text: string }
  | { readonly form: 'short-id' | 'uri' | 'machine-id'; readonly entity: string }
  | { readonly form: 'literal'; readonly text: string }

/** The outcome class a case declares, per posture. Targets are named by machine id. */
export type CorpusExpectation =
  | { readonly outcome: 'resolved'; readonly target: string; readonly exact?: true }
  | { readonly outcome: 'ambiguous'; readonly mustContain: readonly string[] }
  | { readonly outcome: 'none'; readonly reason: 'no-match' | 'unknown-address' }

export interface CorpusCase {
  readonly id: string
  readonly category: CorpusCategory
  readonly ref: CorpusRef
  /**
   * The query's semantic direction. Absent for address forms, which never reach the dense leg.
   * Weights are read against `CORPUS_ENTITIES` family names and machine ids.
   */
  readonly axes?: Readonly<Record<string, number>>
  readonly full: CorpusExpectation
  readonly floor: CorpusExpectation
  // The two fused scores are exactly equal under the full posture.
  readonly equalStrength?: true
  /**
   * The degradation gate's witness: under the shipped margin this case's postures agree, and
   * below the quantised bound the floor posture resolves a DIFFERENT entity. It is what makes
   * the invariant's gate non-vacuous rather than arithmetically unreachable.
   */
  readonly divergenceWitness?: true
  // The floor posture is more confident than the full posture here.
  readonly monotonicityCounterexample?: true
  readonly note?: string
}

/** The axis every deliberate miss points at: shared by no entity, so it admits nothing. */
export const VOID_AXIS = 'axis-void'

/** Two entities at equal weight; squared they sum to one, so the query vector stays a unit. */
const PAIR_NEAR = 0.8
const PAIR_FAR = 0.6
const PAIR_EVEN = 0.7071067811865476

// Every `full`/`floor` pair is derived from the fusion arithmetic in the header.
export const CORPUS_CASES: readonly CorpusCase[] = [
  // ================= exact: tier (a), posture-independent by construction =================
  { id: 'exact-shortid-checkout', category: 'exact', ref: { form: 'short-id', entity: 'checkout-happy-path' }, full: { outcome: 'resolved', target: 'checkout-happy-path', exact: true }, floor: { outcome: 'resolved', target: 'checkout-happy-path', exact: true } },
  { id: 'exact-shortid-nightly', category: 'exact', ref: { form: 'short-id', entity: 'r_nightly_checkout' }, full: { outcome: 'resolved', target: 'r_nightly_checkout', exact: true }, floor: { outcome: 'resolved', target: 'r_nightly_checkout', exact: true } },
  { id: 'exact-shortid-offset', category: 'exact', ref: { form: 'short-id', entity: 'mem_pagination_offset' }, full: { outcome: 'resolved', target: 'mem_pagination_offset', exact: true }, floor: { outcome: 'resolved', target: 'mem_pagination_offset', exact: true } },
  { id: 'exact-shortid-credential', category: 'exact', ref: { form: 'short-id', entity: 'pol_never_reuse_credential' }, full: { outcome: 'resolved', target: 'pol_never_reuse_credential', exact: true }, floor: { outcome: 'resolved', target: 'pol_never_reuse_credential', exact: true } },
  { id: 'exact-shortid-checkout-web', category: 'exact', ref: { form: 'short-id', entity: 'checkout-web' }, full: { outcome: 'resolved', target: 'checkout-web', exact: true }, floor: { outcome: 'resolved', target: 'checkout-web', exact: true }, note: 'slug-addressed: TGT ids are names, not ordinals' },
  { id: 'exact-shortid-audit', category: 'exact', ref: { form: 'short-id', entity: 'zephyr-latency-audit' }, full: { outcome: 'resolved', target: 'zephyr-latency-audit', exact: true }, floor: { outcome: 'resolved', target: 'zephyr-latency-audit', exact: true } },
  { id: 'exact-shortid-visual-review', category: 'exact', ref: { form: 'short-id', entity: 'r_visual_diff_review' }, full: { outcome: 'resolved', target: 'r_visual_diff_review', exact: true }, floor: { outcome: 'resolved', target: 'r_visual_diff_review', exact: true } },
  { id: 'exact-shortid-analytics', category: 'exact', ref: { form: 'short-id', entity: 'analytics-warehouse' }, full: { outcome: 'resolved', target: 'analytics-warehouse', exact: true }, floor: { outcome: 'resolved', target: 'analytics-warehouse', exact: true } },

  { id: 'exact-uri-magic-link', category: 'exact', ref: { form: 'uri', entity: 'signin-magic-link' }, full: { outcome: 'resolved', target: 'signin-magic-link', exact: true }, floor: { outcome: 'resolved', target: 'signin-magic-link', exact: true } },
  { id: 'exact-uri-button-moved', category: 'exact', ref: { form: 'uri', entity: 'mem_checkout_button_moved' }, full: { outcome: 'resolved', target: 'mem_checkout_button_moved', exact: true }, floor: { outcome: 'resolved', target: 'mem_checkout_button_moved', exact: true } },
  { id: 'exact-uri-no-silent-skip', category: 'exact', ref: { form: 'uri', entity: 'pol_no_silent_skip' }, full: { outcome: 'resolved', target: 'pol_no_silent_skip', exact: true }, floor: { outcome: 'resolved', target: 'pol_no_silent_skip', exact: true } },
  { id: 'exact-uri-mobile-ios', category: 'exact', ref: { form: 'uri', entity: 'mobile-ios' }, full: { outcome: 'resolved', target: 'mobile-ios', exact: true }, floor: { outcome: 'resolved', target: 'mobile-ios', exact: true } },
  { id: 'exact-uri-3ds', category: 'exact', ref: { form: 'uri', entity: 'payment-3ds-challenge' }, full: { outcome: 'resolved', target: 'payment-3ds-challenge', exact: true }, floor: { outcome: 'resolved', target: 'payment-3ds-challenge', exact: true } },
  { id: 'exact-uri-disk-full', category: 'exact', ref: { form: 'uri', entity: 'r_chaos_disk_full' }, full: { outcome: 'resolved', target: 'r_chaos_disk_full', exact: true }, floor: { outcome: 'resolved', target: 'r_chaos_disk_full', exact: true } },

  { id: 'exact-machine-basket-add', category: 'exact', ref: { form: 'machine-id', entity: 'basket-add-item' }, full: { outcome: 'resolved', target: 'basket-add-item', exact: true }, floor: { outcome: 'resolved', target: 'basket-add-item', exact: true } },
  { id: 'exact-machine-synonym', category: 'exact', ref: { form: 'machine-id', entity: 'catalogue-synonym-map' }, full: { outcome: 'resolved', target: 'catalogue-synonym-map', exact: true }, floor: { outcome: 'resolved', target: 'catalogue-synonym-map', exact: true } },
  { id: 'exact-machine-clock-skew', category: 'exact', ref: { form: 'machine-id', entity: 'mem_flaky_clock_skew' }, full: { outcome: 'resolved', target: 'mem_flaky_clock_skew', exact: true }, floor: { outcome: 'resolved', target: 'mem_flaky_clock_skew', exact: true } },
  { id: 'exact-machine-ci-budget', category: 'exact', ref: { form: 'machine-id', entity: 'pol_budget_ci_minutes' }, full: { outcome: 'resolved', target: 'pol_budget_ci_minutes', exact: true }, floor: { outcome: 'resolved', target: 'pol_budget_ci_minutes', exact: true } },
  { id: 'exact-machine-support-desk', category: 'exact', ref: { form: 'machine-id', entity: 'support-desk' }, full: { outcome: 'resolved', target: 'support-desk', exact: true }, floor: { outcome: 'resolved', target: 'support-desk', exact: true } },
  { id: 'exact-machine-locale-matrix', category: 'exact', ref: { form: 'machine-id', entity: 'r_locale_matrix' }, full: { outcome: 'resolved', target: 'r_locale_matrix', exact: true }, floor: { outcome: 'resolved', target: 'r_locale_matrix', exact: true } },

  // ================= semantic: no shared word at all, so only meaning can answer ===========
  // Twelve point at one entity's own axis (0.866 on it, 0.25 on a sibling — below tau_dense),
  // so the dense leg admits exactly one candidate and the full posture resolves. The floor
  // posture has no dense leg and the words match nothing, so it is an honest miss.
  { id: 'sem-buy-something', category: 'semantic', ref: { form: 'text', text: 'where we buy something' }, axes: { 'checkout-happy-path': 1 }, full: { outcome: 'resolved', target: 'checkout-happy-path' }, floor: { outcome: 'none', reason: 'no-match' }, note: "the product bar, verbatim" },
  { id: 'sem-authentication', category: 'semantic', ref: { form: 'text', text: 'authentication handshake' }, axes: { 'signin-stored-password': 1 }, full: { outcome: 'resolved', target: 'signin-stored-password' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-trolley-contents', category: 'semantic', ref: { form: 'text', text: 'trolley contents' }, axes: { 'basket-add-item': 1 }, full: { outcome: 'resolved', target: 'basket-add-item' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-money-failure', category: 'semantic', ref: { form: 'text', text: 'money movement failure' }, axes: { 'payment-declined-retry': 1 }, full: { outcome: 'resolved', target: 'payment-declined-retry' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-find-merchandise', category: 'semantic', ref: { form: 'text', text: 'finding merchandise fast' }, axes: { 'catalogue-typeahead': 1 }, full: { outcome: 'resolved', target: 'catalogue-typeahead' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-remove-profile', category: 'semantic', ref: { form: 'text', text: 'removing my profile forever' }, axes: { 'account-erasure': 1 }, full: { outcome: 'resolved', target: 'account-erasure' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-oversubscription', category: 'semantic', ref: { form: 'text', text: 'keeping oversubscription honest' }, axes: { 'oversell-guard': 1 }, full: { outcome: 'resolved', target: 'oversell-guard' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-overnight-batch', category: 'semantic', ref: { form: 'text', text: 'overnight automated batch' }, axes: { 'r_nightly_checkout': 1 }, full: { outcome: 'resolved', target: 'r_nightly_checkout' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-european-datacentre', category: 'semantic', ref: { form: 'text', text: 'european datacentre pass' }, axes: { 'r_canary_frankfurt_dawn': 1 }, full: { outcome: 'resolved', target: 'r_canary_frankfurt_dawn' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-speed-measurement', category: 'semantic', ref: { form: 'text', text: 'speed measurement' }, axes: { 'r_perf_budget': 1 }, full: { outcome: 'resolved', target: 'r_perf_budget' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-keys-fresh', category: 'semantic', ref: { form: 'text', text: 'keeping keys fresh' }, axes: { 'pol_secret_rotation_ninety': 1 }, full: { outcome: 'resolved', target: 'pol_secret_rotation_ninety' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-shop-front', category: 'semantic', ref: { form: 'text', text: 'shop front website' }, axes: { 'checkout-web': 1 }, full: { outcome: 'resolved', target: 'checkout-web' }, floor: { outcome: 'none', reason: 'no-match' } },

  // Eight point at a FAMILY axis: every member scores 0.5, so the dense leg admits the whole
  // family and no member can clear the margin over its siblings. Meaning alone is not enough.
  { id: 'sem-buying-journey', category: 'semantic', ref: { form: 'text', text: 'buying journey' }, axes: { 'fam-checkout': 1 }, full: { outcome: 'ambiguous', mustContain: ['checkout-happy-path', 'checkout-guest-path'] }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-proving-who', category: 'semantic', ref: { form: 'text', text: 'proving who you are' }, axes: { 'fam-signin': 1 }, full: { outcome: 'ambiguous', mustContain: ['signin-stored-password', 'signin-magic-link'] }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-trolley-behaviour', category: 'semantic', ref: { form: 'text', text: 'trolley behaviour' }, axes: { 'fam-basket': 1 }, full: { outcome: 'ambiguous', mustContain: ['basket-add-item', 'basket-remove-item'] }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-money-movement', category: 'semantic', ref: { form: 'text', text: 'money movement' }, axes: { 'fam-payment': 1 }, full: { outcome: 'ambiguous', mustContain: ['payment-3ds-challenge', 'payment-apple-wallet'] }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-browsing', category: 'semantic', ref: { form: 'text', text: 'browsing merchandise' }, axes: { 'fam-catalogue': 1 }, full: { outcome: 'ambiguous', mustContain: ['catalogue-typeahead', 'catalogue-empty-state'] }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-planned-executions', category: 'semantic', ref: { form: 'text', text: 'planned executions' }, axes: { 'fam-schedule': 1 }, full: { outcome: 'ambiguous', mustContain: ['r_nightly_checkout', 'r_smoke_signin'] }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-confidentiality', category: 'semantic', ref: { form: 'text', text: 'confidentiality rules' }, axes: { 'fam-secrets': 1 }, full: { outcome: 'ambiguous', mustContain: ['pol_never_reuse_credential', 'pol_secret_rotation_ninety'] }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'sem-twin-timings', category: 'semantic', ref: { form: 'text', text: 'twin timings' }, axes: { 'fam-zephyr': 1 }, full: { outcome: 'ambiguous', mustContain: ['zephyr-latency-probe', 'zephyr-latency-audit'] }, floor: { outcome: 'none', reason: 'no-match' } },

  // Equal-strength pairs: the two legs rank each pair in opposite orders, fusing to a tie.
  { id: 'twin-equal-quarantine', category: 'near-twin', ref: { form: 'text', text: 'quarantine spec' }, axes: { 'quarantine-flake-report': PAIR_NEAR, 'quarantine-flake-triage': PAIR_FAR }, equalStrength: true, full: { outcome: 'ambiguous', mustContain: ['quarantine-flake-triage', 'quarantine-flake-report'] }, floor: { outcome: 'ambiguous', mustContain: ['quarantine-flake-triage', 'quarantine-flake-report'] } },
  { id: 'twin-equal-latency', category: 'near-twin', ref: { form: 'text', text: 'latency' }, axes: { 'zephyr-latency-audit': PAIR_NEAR, 'zephyr-latency-probe': PAIR_FAR }, equalStrength: true, full: { outcome: 'ambiguous', mustContain: ['zephyr-latency-probe', 'zephyr-latency-audit'] }, floor: { outcome: 'ambiguous', mustContain: ['zephyr-latency-probe', 'zephyr-latency-audit'] } },
  { id: 'twin-equal-pagination', category: 'near-twin', ref: { form: 'text', text: 'pagination cursor offset token' }, axes: { 'mem_pagination_cursor': PAIR_NEAR, 'mem_pagination_offset': PAIR_FAR }, equalStrength: true, full: { outcome: 'ambiguous', mustContain: ['mem_pagination_offset', 'mem_pagination_cursor'] }, floor: { outcome: 'ambiguous', mustContain: ['mem_pagination_offset', 'mem_pagination_cursor'] } },
  { id: 'twin-equal-canary', category: 'near-twin', ref: { form: 'text', text: 'canary frankfurt' }, axes: { 'r_canary_frankfurt_dusk': PAIR_NEAR, 'r_canary_frankfurt_dawn': PAIR_FAR }, equalStrength: true, full: { outcome: 'ambiguous', mustContain: ['r_canary_frankfurt_dawn', 'r_canary_frankfurt_dusk'] }, floor: { outcome: 'ambiguous', mustContain: ['r_canary_frankfurt_dawn', 'r_canary_frankfurt_dusk'] } },
  { id: 'twin-equal-rotation', category: 'near-twin', ref: { form: 'text', text: 'rotate deploy secret' }, axes: { 'pol_secret_rotation_thirty': PAIR_NEAR, 'pol_secret_rotation_ninety': PAIR_FAR }, equalStrength: true, full: { outcome: 'ambiguous', mustContain: ['pol_secret_rotation_ninety', 'pol_secret_rotation_thirty'] }, floor: { outcome: 'ambiguous', mustContain: ['pol_secret_rotation_ninety', 'pol_secret_rotation_thirty'] } },

  // The degradation gate's witness. Two lexical candidates; the dense leg admits only the one
  // the lexical leg put SECOND, so the full posture resolves it and the floor posture — which
  // has the two of them 0.008 apart — refuses. Below that gap the floor would resolve the other
  // one, which is the divergence the shipped margin makes unreachable.
  { id: 'twin-witness-pagination', category: 'near-twin', ref: { form: 'text', text: 'pagination token' }, axes: { 'mem_pagination_cursor': 1 }, divergenceWitness: true, full: { outcome: 'resolved', target: 'mem_pagination_cursor' }, floor: { outcome: 'ambiguous', mustContain: ['mem_pagination_offset', 'mem_pagination_cursor'] } },

  // Two cases where one word names exactly one entity and the SENSE of the query names another.
  // The floor posture has nothing to weigh its single lexical match against, so it answers with
  // confidence; the full posture sees the rival the words never mentioned and refuses. Authored
  // deliberately, because a corpus with no case of this shape would make the monotone half of
  // the degradation claim look true when it is only untested.
  { id: 'twin-degrade-cursor', category: 'near-twin', ref: { form: 'text', text: 'cursor' }, axes: { 'mem_modal_focus_trap': 1 }, monotonicityCounterexample: true, full: { outcome: 'ambiguous', mustContain: ['mem_pagination_cursor', 'mem_modal_focus_trap'] }, floor: { outcome: 'resolved', target: 'mem_pagination_cursor' } },
  { id: 'twin-degrade-border', category: 'near-twin', ref: { form: 'text', text: 'border' }, axes: { 'r_canary_frankfurt_dawn': 1 }, monotonicityCounterexample: true, full: { outcome: 'ambiguous', mustContain: ['payment-currency-switch', 'r_canary_frankfurt_dawn'] }, floor: { outcome: 'resolved', target: 'payment-currency-switch' } },

  { id: 'twin-checkout-path', category: 'near-twin', ref: { form: 'text', text: 'path' }, axes: { 'fam-checkout': 1 }, full: { outcome: 'ambiguous', mustContain: ['checkout-happy-path', 'checkout-guest-path'] }, floor: { outcome: 'ambiguous', mustContain: ['checkout-happy-path', 'checkout-guest-path'] } },
  { id: 'twin-checkout-basket', category: 'near-twin', ref: { form: 'text', text: 'checkout basket' }, axes: { 'fam-basket': 1 }, full: { outcome: 'ambiguous', mustContain: [] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'twin-flaky-spec', category: 'near-twin', ref: { form: 'text', text: 'flaky spec' }, axes: { 'fam-quarantine': 1 }, full: { outcome: 'ambiguous', mustContain: ['quarantine-flake-triage', 'quarantine-flake-report'] }, floor: { outcome: 'ambiguous', mustContain: ['quarantine-flake-triage', 'quarantine-flake-report'] } },
  { id: 'twin-sign-password', category: 'near-twin', ref: { form: 'text', text: 'sign password' }, axes: { 'fam-signin': 1 }, full: { outcome: 'ambiguous', mustContain: [] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'twin-visual', category: 'near-twin', ref: { form: 'text', text: 'visual' }, axes: { 'fam-visual': 1 }, full: { outcome: 'ambiguous', mustContain: ['r_visual_baseline', 'r_visual_diff_review'] }, floor: { outcome: 'ambiguous', mustContain: ['r_visual_baseline', 'r_visual_diff_review'] } },
  { id: 'twin-pilot', category: 'near-twin', ref: { form: 'text', text: 'pilot exercise' }, axes: { 'fam-pilot': 1 }, full: { outcome: 'ambiguous', mustContain: ['r_pilot_beta_cohort', 'r_pilot_dogfood'] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'twin-chaos', category: 'near-twin', ref: { form: 'text', text: 'chaos exercise' }, axes: { 'fam-chaos': 1 }, full: { outcome: 'ambiguous', mustContain: ['r_chaos_latency', 'r_chaos_disk_full'] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'twin-locales', category: 'near-twin', ref: { form: 'text', text: 'locales' }, axes: { 'fam-locale': 1 }, full: { outcome: 'ambiguous', mustContain: ['mem_locale_decimal_comma', 'mem_locale_rtl_mirror'] }, floor: { outcome: 'ambiguous', mustContain: ['mem_locale_decimal_comma', 'mem_locale_rtl_mirror'] } },
  { id: 'twin-rotation-days', category: 'near-twin', ref: { form: 'text', text: 'rotate secret days' }, axes: { 'fam-secrets': 1 }, full: { outcome: 'ambiguous', mustContain: ['pol_secret_rotation_ninety', 'pol_secret_rotation_thirty'] }, floor: { outcome: 'ambiguous', mustContain: ['pol_secret_rotation_ninety', 'pol_secret_rotation_thirty'] } },
  { id: 'twin-frankfurt', category: 'near-twin', ref: { form: 'text', text: 'frankfurt region' }, axes: { 'fam-canary': 1 }, full: { outcome: 'ambiguous', mustContain: ['r_canary_frankfurt_dawn', 'r_canary_frankfurt_dusk'] }, floor: { outcome: 'ambiguous', mustContain: ['r_canary_frankfurt_dawn', 'r_canary_frankfurt_dusk'] } },
  { id: 'twin-quarantine-word', category: 'near-twin', ref: { form: 'text', text: 'quarantine' }, axes: { 'fam-quarantine': 1 }, full: { outcome: 'ambiguous', mustContain: ['quarantine-flake-triage', 'quarantine-flake-report'] }, floor: { outcome: 'ambiguous', mustContain: ['quarantine-flake-triage', 'quarantine-flake-report'] } },
  { id: 'twin-zephyr-gateway', category: 'near-twin', ref: { form: 'text', text: 'zephyr gateway' }, axes: { 'fam-zephyr': 1 }, full: { outcome: 'ambiguous', mustContain: [] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'twin-console', category: 'near-twin', ref: { form: 'text', text: 'console' }, axes: { 'admin-console': PAIR_EVEN, 'warehouse-console': PAIR_EVEN }, full: { outcome: 'ambiguous', mustContain: ['admin-console', 'warehouse-console'] }, floor: { outcome: 'ambiguous', mustContain: ['admin-console', 'warehouse-console'] } },
  { id: 'twin-mobile-app', category: 'near-twin', ref: { form: 'text', text: 'mobile application' }, axes: { 'fam-mobile': 1 }, full: { outcome: 'ambiguous', mustContain: ['mobile-android', 'mobile-ios'] }, floor: { outcome: 'ambiguous', mustContain: ['mobile-android', 'mobile-ios'] } },
  { id: 'twin-catalogue', category: 'near-twin', ref: { form: 'text', text: 'catalogue' }, axes: { 'fam-catalogue': 1 }, full: { outcome: 'ambiguous', mustContain: [] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'twin-audit-word', category: 'near-twin', ref: { form: 'text', text: 'audit' }, axes: { 'r_accessibility_audit': PAIR_EVEN, 'zephyr-latency-audit': PAIR_EVEN }, full: { outcome: 'ambiguous', mustContain: ['r_accessibility_audit', 'zephyr-latency-audit'] }, floor: { outcome: 'ambiguous', mustContain: ['r_accessibility_audit', 'zephyr-latency-audit'] } },

  // ================= typo: one letter away from a word somebody meant =====================
  // Three shapes, and the third is the interesting one. When the misspelling leaves enough
  // correct words to name ONE entity, both postures resolve. When the correct remainder names
  // many, both postures disambiguate. When the misspelling eats the only distinguishing word,
  // the full posture still answers from meaning and the floor posture honestly misses.
  { id: 'typo-oversell-unit', category: 'typo', ref: { form: 'text', text: 'oversel guard unit' }, axes: { 'oversell-guard': 1 }, full: { outcome: 'resolved', target: 'oversell-guard' }, floor: { outcome: 'resolved', target: 'oversell-guard' } },
  { id: 'typo-typeahead-products', category: 'typo', ref: { form: 'text', text: 'typehead products' }, axes: { 'catalogue-typeahead': 1 }, full: { outcome: 'resolved', target: 'catalogue-typeahead' }, floor: { outcome: 'resolved', target: 'catalogue-typeahead' } },
  { id: 'typo-3ds-challenge', category: 'typo', ref: { form: 'text', text: '3ds challange' }, axes: { 'payment-3ds-challenge': 1 }, full: { outcome: 'resolved', target: 'payment-3ds-challenge' }, floor: { outcome: 'resolved', target: 'payment-3ds-challenge' } },
  { id: 'typo-idempotency-key', category: 'typo', ref: { form: 'text', text: 'idempotancy key' }, axes: { 'payment-idempotency-key': 1 }, full: { outcome: 'resolved', target: 'payment-idempotency-key' }, floor: { outcome: 'resolved', target: 'payment-idempotency-key' } },
  { id: 'typo-magic-link', category: 'typo', ref: { form: 'text', text: 'magik link' }, axes: { 'signin-magic-link': 1 }, full: { outcome: 'resolved', target: 'signin-magic-link' }, floor: { outcome: 'resolved', target: 'signin-magic-link' } },
  { id: 'typo-coupon-code', category: 'typo', ref: { form: 'text', text: 'coupn code' }, axes: { 'checkout-coupon-code': 1 }, full: { outcome: 'resolved', target: 'checkout-coupon-code' }, floor: { outcome: 'resolved', target: 'checkout-coupon-code' } },
  { id: 'typo-pagination-cursor', category: 'typo', ref: { form: 'text', text: 'paginaton cursor' }, axes: { 'mem_pagination_cursor': 1 }, full: { outcome: 'resolved', target: 'mem_pagination_cursor' }, floor: { outcome: 'resolved', target: 'mem_pagination_cursor' } },
  { id: 'typo-rollback-drill', category: 'typo', ref: { form: 'text', text: 'rollbak drill' }, axes: { 'r_rollback_drill': 1 }, full: { outcome: 'resolved', target: 'r_rollback_drill' }, floor: { outcome: 'resolved', target: 'r_rollback_drill' } },
  { id: 'typo-notification-prefs', category: 'typo', ref: { form: 'text', text: 'notifcation preferences' }, axes: { 'account-notification-prefs': 1 }, full: { outcome: 'resolved', target: 'account-notification-prefs' }, floor: { outcome: 'resolved', target: 'account-notification-prefs' } },

  { id: 'typo-checkout-basket', category: 'typo', ref: { form: 'text', text: 'chekout basket' }, axes: { 'fam-basket': 1 }, full: { outcome: 'ambiguous', mustContain: [] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'typo-lockout-failures', category: 'typo', ref: { form: 'text', text: 'signin lockut failures' }, axes: { 'signin-lockout': PAIR_EVEN, 'pol_isolate_after_three': PAIR_EVEN }, full: { outcome: 'ambiguous', mustContain: ['signin-lockout', 'pol_isolate_after_three'] }, floor: { outcome: 'ambiguous', mustContain: ['signin-lockout', 'pol_isolate_after_three'] } },
  { id: 'typo-expired-card', category: 'typo', ref: { form: 'text', text: 'expird card' }, axes: { 'fam-checkout': 1 }, full: { outcome: 'ambiguous', mustContain: ['checkout-expired-card'] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'typo-frankfurt-canary', category: 'typo', ref: { form: 'text', text: 'franfurt canary' }, axes: { 'fam-canary': 1 }, full: { outcome: 'ambiguous', mustContain: ['r_canary_frankfurt_dawn', 'r_canary_frankfurt_dusk'] }, floor: { outcome: 'ambiguous', mustContain: ['r_canary_frankfurt_dawn', 'r_canary_frankfurt_dusk'] } },
  { id: 'typo-zephyr-gateway', category: 'typo', ref: { form: 'text', text: 'zephry gateway' }, axes: { 'fam-zephyr': 1 }, full: { outcome: 'ambiguous', mustContain: [] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'typo-accessibility-audit', category: 'typo', ref: { form: 'text', text: 'acessibility audit' }, axes: { 'r_accessibility_audit': PAIR_EVEN, 'zephyr-latency-audit': PAIR_EVEN }, full: { outcome: 'ambiguous', mustContain: ['r_accessibility_audit', 'zephyr-latency-audit'] }, floor: { outcome: 'ambiguous', mustContain: ['r_accessibility_audit', 'zephyr-latency-audit'] } },
  { id: 'typo-quarantine-spec', category: 'typo', ref: { form: 'text', text: 'quarantne spec' }, axes: { 'fam-quarantine': 1 }, full: { outcome: 'ambiguous', mustContain: ['quarantine-flake-triage', 'quarantine-flake-report'] }, floor: { outcome: 'ambiguous', mustContain: ['quarantine-flake-triage', 'quarantine-flake-report'] } },

  { id: 'typo-oversell-only', category: 'typo', ref: { form: 'text', text: 'oversel gaurd' }, axes: { 'oversell-guard': 1 }, full: { outcome: 'resolved', target: 'oversell-guard' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'typo-typeahead-only', category: 'typo', ref: { form: 'text', text: 'tyepahead' }, axes: { 'catalogue-typeahead': 1 }, full: { outcome: 'resolved', target: 'catalogue-typeahead' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'typo-account-erasure', category: 'typo', ref: { form: 'text', text: 'acount erasure' }, axes: { 'account-erasure': 1 }, full: { outcome: 'resolved', target: 'account-erasure' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'typo-screenshot-redaction', category: 'typo', ref: { form: 'text', text: 'scrensot redaction' }, axes: { 'pol_screenshot_redaction': 1 }, full: { outcome: 'resolved', target: 'pol_screenshot_redaction' }, floor: { outcome: 'none', reason: 'no-match' } },

  // ================= miss: the never-guess floor, in five shapes =========================
  // Ten name nothing at all, four are well-formed addresses nobody minted, one is address-shaped
  // in a prefix that was never a kind, four are made of words the corpus is full of but name no
  // entity, and two are degenerate input. Not one of them may come back as a confident answer.
  { id: 'miss-quantum', category: 'miss', ref: { form: 'text', text: 'quantum entanglement harness' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'miss-submarine', category: 'miss', ref: { form: 'text', text: 'submarine periscope alignment' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'miss-volcano', category: 'miss', ref: { form: 'text', text: 'volcano eruption forecast' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'miss-origami', category: 'miss', ref: { form: 'text', text: 'origami folding sequence' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'miss-glacier', category: 'miss', ref: { form: 'text', text: 'glacier retreat survey' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'miss-beekeeping', category: 'miss', ref: { form: 'text', text: 'beekeeping hive census' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'miss-harpsichord', category: 'miss', ref: { form: 'text', text: 'harpsichord tuning ritual' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'miss-tectonic', category: 'miss', ref: { form: 'text', text: 'tectonic drift estimate' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'miss-sourdough', category: 'miss', ref: { form: 'text', text: 'sourdough starter hydration' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'miss-trilobite', category: 'miss', ref: { form: 'text', text: 'trilobite fossil layer' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },

  { id: 'miss-address-mem-404', category: 'miss', ref: { form: 'literal', text: 'MEM-404' }, full: { outcome: 'none', reason: 'unknown-address' }, floor: { outcome: 'none', reason: 'unknown-address' } },
  { id: 'miss-address-tst-999', category: 'miss', ref: { form: 'literal', text: 'TST-999' }, full: { outcome: 'none', reason: 'unknown-address' }, floor: { outcome: 'none', reason: 'unknown-address' } },
  { id: 'miss-address-uri-pol', category: 'miss', ref: { form: 'literal', text: 'agentqa://policy/POL-777' }, full: { outcome: 'none', reason: 'unknown-address' }, floor: { outcome: 'none', reason: 'unknown-address' } },
  { id: 'miss-address-uri-tgt', category: 'miss', ref: { form: 'literal', text: 'agentqa://target/TGT-nowhere' }, full: { outcome: 'none', reason: 'unknown-address' }, floor: { outcome: 'none', reason: 'unknown-address' } },
  { id: 'miss-address-shaped-never-a-kind', category: 'miss', ref: { form: 'literal', text: 'ZZZ-7' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' }, note: 'address-shaped in a prefix outside the vocabulary: parses as nothing and falls through to free text' },

  { id: 'miss-noise-elephant', category: 'miss', ref: { form: 'text', text: 'the flaky elephant migration' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'ambiguous', mustContain: [] }, floor: { outcome: 'ambiguous', mustContain: [] }, note: 'common words, no entity: a disambiguation card is the honest answer' },
  { id: 'miss-noise-production', category: 'miss', ref: { form: 'text', text: 'every page production' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'ambiguous', mustContain: [] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'miss-noise-card-account', category: 'miss', ref: { form: 'text', text: 'a card account' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'ambiguous', mustContain: [] }, floor: { outcome: 'ambiguous', mustContain: [] } },
  { id: 'miss-noise-over-suite', category: 'miss', ref: { form: 'text', text: 'over the suite' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'ambiguous', mustContain: [] }, floor: { outcome: 'ambiguous', mustContain: [] } },

  { id: 'miss-blank', category: 'miss', ref: { form: 'literal', text: '   ' }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
  { id: 'miss-elephants', category: 'miss', ref: { form: 'text', text: 'nothing here mentions elephants' }, axes: { [VOID_AXIS]: 1 }, full: { outcome: 'none', reason: 'no-match' }, floor: { outcome: 'none', reason: 'no-match' } },
]

/**
 * Every axis name the corpus uses, sorted, so an axis's dimension is a function of the fixture
 * and not of declaration order. Two runs therefore embed the same text to the same bytes.
 */
export function corpusAxes(): readonly string[] {
  const names = new Set<string>([VOID_AXIS])
  for (const entity of CORPUS_ENTITIES) {
    names.add(entity.family)
    names.add(entity.machineId)
  }
  for (const testCase of CORPUS_CASES) {
    for (const axis of Object.keys(testCase.axes ?? {})) names.add(axis)
  }
  return [...names].sort()
}

/** A unit vector over the corpus axes, with `dim` taken from the active embedding profile. */
export function corpusVector(
  axes: Readonly<Record<string, number>>,
  dim: number,
): Float32Array {
  const index = new Map(corpusAxes().map((name, position) => [name, position]))
  const vector = new Float32Array(dim)
  let squared = 0
  for (const [name, weight] of Object.entries(axes)) {
    const position = index.get(name)
    if (position === undefined) {
      throw new Error(`the corpus declares no axis named ${JSON.stringify(name)}`)
    }
    if (position >= dim) {
      throw new RangeError(`the corpus needs ${position + 1} dimensions; the profile has ${dim}`)
    }
    vector[position] = weight
    squared += weight * weight
  }
  if (squared === 0) throw new Error('a corpus vector needs at least one non-zero axis')
  const length = Math.sqrt(squared)
  for (let position = 0; position < vector.length; position += 1) {
    vector[position] = vector[position]! / length
  }
  return vector
}

/** An entity's authored direction: half a family, most of itself. */
export function entityAxes(entity: CorpusEntity): Record<string, number> {
  return { [entity.family]: FAMILY_AXIS_WEIGHT, [entity.machineId]: OWN_AXIS_WEIGHT }
}
