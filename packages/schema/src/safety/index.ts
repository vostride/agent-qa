export type { RiskActionDescriptor } from './action-descriptor'
// 401-15 (WR-01): the scrub, published from the descriptor module it was written for.
// 2026-10-02 (432-42): the descriptor's disclosure field is deleted; the production refusal applies it.
export {
  DISCLOSURE_FRAGMENT_MAX_LENGTH,
  DISCLOSURE_REPLACEMENT_CHARACTER,
  DISCLOSURE_TEXT_MAX_LENGTH,
  DISCLOSURE_TRUNCATION_MARK,
  scrubDisclosureFragment,
  scrubDisclosureText,
} from './action-descriptor'
// 391-11 (REVIEW WR-05) published the scope key set here, spelled ONCE, so an out-of-package
// differential could range it. Nothing is exported under this note any more (2026-10-03).
// 432-18 moved `STANDING_APPROVAL_SCOPE` beside it; 432-21 (D-12) deleted it with the MCP bearer
// credential that carried it. 2026-10-02 (432-39, D-12): the `TrustCredential` and `TrustScope`
// caller types are deleted with the caller's `credential` member. 2026-10-02 (432-42, D-12): the key
// set and its type are deleted with `trust-credential.ts`, the last member of the module; nothing
// in production read them.
// 432-18 (D-14/D-15): the grant ledger, the protected-class set and the grant op contracts are
// deleted. 432-22 (D-12): the trust-scope wire projection (`grant-ops.ts`) is deleted with the
// run-service token DTO, its last consumer.
// 2026-10-15 (441-45, D-12/D-15): the masking context, guardrail policy, scan, content-origin and
// hook-result contracts are deleted with the safety modules that implemented them (441-33).
