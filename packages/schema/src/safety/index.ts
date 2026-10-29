export type { RiskActionDescriptor } from './action-descriptor'
// The disclosure fragment scrub, published from the descriptor module.
export {
  DISCLOSURE_FRAGMENT_MAX_LENGTH,
  DISCLOSURE_REPLACEMENT_CHARACTER,
  DISCLOSURE_TRUNCATION_MARK,
  scrubDisclosureFragment,
} from './action-descriptor'
// 391-11 (REVIEW WR-05) published the scope key set here, spelled ONCE, so an out-of-package
// differential could range it. Nothing is exported under this note any more.
// 432-18 moved `STANDING_APPROVAL_SCOPE` beside it; 432-21 deleted it with the MCP bearer
// credential that carried it. 2026-10-02: the `TrustCredential` and `TrustScope`
// caller types are deleted with the caller's `credential` member. 2026-10-02: the key
// set and its type are deleted with `trust-credential.ts`, the last member of the module; nothing
// in production read them.
// the grant ledger, the protected-class set and the grant op contracts are
// deleted. 432-22: the trust-scope wire projection (`grant-ops.ts`) is deleted with the
// run-service token DTO, its last consumer.
// the masking context, guardrail policy, scan, content-origin and
// hook-result contracts are deleted with the safety modules that implemented them.
