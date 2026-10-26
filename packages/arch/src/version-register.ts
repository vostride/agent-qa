// The schema versions agent-qa owns, each at its one readable value, and the version-shaped
// names that are not schema versions. Paths are relative to the repository root.

export type VersionField =
  | 'schemaVersion'
  | 'version'
  | 'user_version'
  | 'token-prefix'
  | 'meta'
  | 'contractVersion'

export type ReadingRule = 'refuse' | 'rebuild' | 'miss' | 'no-reader'

export interface VersionCopy {
  readonly site: string
  readonly spelling: string
}

export interface RegisteredVersion {
  readonly id: string
  readonly site: string
  readonly name?: string
  readonly field: VersionField
  readonly value: 2 | 'v2'
  readonly rule: ReadingRule
  readonly copies?: readonly VersionCopy[]
}

export type ExclusionCategory =
  | 'external-spec'
  | 'package-version'
  | 'content-version'
  | 'domain-tag'
  | 'floor-asset'
  | 'historical-script'
  | 'label'

export interface VersionExclusion {
  readonly site: string
  readonly name: string
  readonly category: ExclusionCategory
  readonly reason: string
  readonly inline?: { readonly literal: number; readonly count: number }
}

export interface InlineStamp {
  readonly site: string
  readonly literal: 2
  readonly count: number
  readonly id: string
}

export interface JsonStamp {
  readonly file: string
  readonly key: 'schemaVersion' | 'version'
  readonly value: 2
}

export interface FixtureStampExclusion {
  readonly file: string
  readonly reason: string
}

export const VERSION_REGISTER: readonly RegisteredVersion[] = [
  { id: 'completed-run-handoff', site: 'packages/schema/src/handoff/completed-run-handoff.ts', name: 'CURRENT_HANDOFF_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'runs-database', site: 'packages/dashboard-server/src/db/schema.ts', name: 'SCHEMA_VERSION', field: 'user_version', value: 2, rule: 'refuse', copies: [{ site: 'packages/dashboard-server/src/db/schema.ts', spelling: 'version: ' }] },
  { id: 'agent-job-store', site: 'packages/agent-local/src/store/sqlite-job-store.ts', name: 'AGENT_JOB_STORE_USER_VERSION', field: 'user_version', value: 2, rule: 'refuse' },
  { id: 'knowledge-index', site: 'packages/knowledge-local/src/index-open.ts', name: 'INDEX_SCHEMA_VERSION', field: 'meta', value: 2, rule: 'rebuild' },
  { id: 'knowledge-index-rendering', site: 'packages/knowledge-local/src/index-open.ts', name: 'INDEX_RENDERING_SCHEMA_VERSION', field: 'meta', value: 2, rule: 'rebuild' },
  { id: 'action-cache', site: 'packages/runner-local/src/fs-action-cache.ts', name: 'CACHE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'miss' },
  { id: 'run-notification', site: 'packages/schema/src/notification/run-notification.ts', name: 'CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'curation-tail-receipt', site: 'packages/cli/src/curation/curation-tail.ts', name: 'CURATION_TAIL_RECEIPT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'rebuild' },
  { id: 'run-outcomes-projection', site: 'packages/knowledge-local/src/projection/run-outcomes.ts', name: 'RUN_OUTCOMES_PROJECTION_VERSION', field: 'meta', value: 2, rule: 'rebuild' },
  { id: 'canary-queue', site: 'packages/knowledge-local/src/canary-emit.ts', name: 'CANARY_QUEUE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'embedder-worker-registration', site: 'packages/knowledge-local/src/embedder-worker/worker-registration.ts', name: 'EMBEDDER_WORKER_REGISTRATION_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'embedder-worker-protocol', site: 'packages/knowledge-local/src/embedder-worker/worker-registration.ts', name: 'EMBEDDER_WORKER_PROTOCOL_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'purge-intent', site: 'packages/knowledge-local/src/purge.ts', name: 'PURGE_INTENT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'auth-state-metadata', site: 'packages/core/src/auth-state/schema.ts', name: 'AUTH_STATE_SCHEMA_VERSION', field: 'version', value: 2, rule: 'miss', copies: [{ site: 'packages/dashboard-ui/src/lib/api.ts', spelling: 'AUTH_STATE_METADATA_VERSION' }] },
  { id: 'product-tour-cookie', site: 'packages/dashboard-ui/src/lib/product-tour-state.ts', name: 'PRODUCT_TOUR_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'miss' },
  { id: 'run-artifact', site: 'packages/schema/src/run/run-artifact.ts', name: 'RUN_ARTIFACT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'no-reader' },
  { id: 'knowledge-bundle', site: 'packages/schema/src/knowledge/bundle-files.ts', name: 'BUNDLE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'distilled-observation', site: 'packages/schema/src/knowledge/distilled-observation.ts', name: 'DISTILLED_OBSERVATION_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'gate-receipt', site: 'packages/schema/src/knowledge/gate-receipt.ts', name: 'GATE_RECEIPT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'procedure-body', site: 'packages/schema/src/knowledge/procedure-steps.ts', name: 'PROCEDURE_BODY_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'miss' },
  { id: 'purge-receipt', site: 'packages/knowledge-local/src/purge-receipt.ts', name: 'PURGE_RECEIPT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'run-analysis', site: 'packages/schema/src/verdict/analysis-artifact.ts', name: 'CURRENT_ANALYSIS_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'run-evidence-document', site: 'packages/schema/src/run/evidence.ts', name: 'RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'served-brief-proof', site: 'packages/schema/src/brief/guard-lossless-served-brief.ts', name: 'SERVED_BRIEF_PROOF_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'retrieval-trace', site: 'packages/schema/src/brief/retrieval-trace.ts', name: 'RETRIEVAL_TRACE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'bus-events', site: 'packages/schema/src/run/bus-events.ts', name: 'CURRENT_BUS_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'no-reader' },
  { id: 'mark-receipt', site: 'packages/schema/src/functions/feedback.ts', name: 'MARK_RECEIPT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'improvement-plan', site: 'packages/schema/src/functions/feedback.ts', name: 'IMPROVEMENT_PLAN_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'commit-receipt', site: 'packages/schema/src/knowledge/change.ts', name: 'COMMIT_RECEIPT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'forget-receipt', site: 'packages/schema/src/knowledge/change.ts', name: 'FORGET_RECEIPT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'rebuild' },
  { id: 'chat-session', site: 'packages/schema/src/chat/session-events.ts', name: 'CURRENT_CHAT_SESSION_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'run-config-record', site: 'packages/cli/src/curation/run-curation-context.ts', name: 'RUN_CONFIG_RECORD_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'miss' },
  { id: 'daemon-identity', site: 'packages/cli/src/daemon/server.ts', name: 'DAEMON_IDENTITY_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'invoke-envelope', site: 'packages/cli/src/daemon/server.ts', name: 'INVOKE_ENVELOPE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'daemon-registration', site: 'packages/cli/src/daemon/registration.ts', name: 'DAEMON_REGISTRATION_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'live-url-token', site: 'packages/agent/src/functions/live-url.ts', name: 'LIVE_URL_TOKEN_VERSION', field: 'token-prefix', value: 'v2', rule: 'refuse' },
  { id: 'run-summary', site: 'packages/schema/src/functions/runs.ts', name: 'RUN_SUMMARY_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'no-reader' },
  { id: 'run-detail', site: 'packages/schema/src/functions/runs.ts', name: 'RUN_DETAIL_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'no-reader' },
  { id: 'run-start-acknowledgement', site: 'packages/schema/src/functions/runs.ts', name: 'RUN_START_ACKNOWLEDGEMENT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'no-reader' },
  { id: 'run-event-envelope', site: 'packages/schema/src/functions/runs.ts', name: 'RUN_EVENT_ENVELOPE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'no-reader' },
  { id: 'run-service-contract', site: 'packages/schema/src/functions/run-service.ts', name: 'RUN_SERVICE_CONTRACT_VERSION', field: 'contractVersion', value: 2, rule: 'no-reader' },
  { id: 'masked-resolved-config', site: 'packages/schema/src/functions/config.ts', name: 'MASKED_RESOLVED_CONFIG_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'knowledge-bundle-summary', site: 'packages/schema/src/functions/knowledge.ts', name: 'KNOWLEDGE_BUNDLE_SUMMARY_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'no-reader' },
  { id: 'inspect-record-view', site: 'packages/schema/src/knowledge/maintenance-views.ts', name: 'INSPECT_RECORD_VIEW_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'record-change', site: 'packages/schema/src/knowledge/maintenance-views.ts', name: 'RECORD_CHANGE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'curation-snapshot', site: 'packages/schema/src/notification/curation-snapshot.ts', name: 'CURATION_SNAPSHOT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'job-checkpoint', site: 'packages/schema/src/job/job-checkpoint.ts', name: 'JOB_CHECKPOINT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'draft-receipt', site: 'packages/schema/src/authoring/draft-receipt.ts', name: 'CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'addressing-ledger', site: 'packages/knowledge-local/src/addressing/ledger.ts', name: 'ADDRESSING_LEDGER_USER_VERSION', field: 'user_version', value: 2, rule: 'refuse' },
  { id: 'entity-index', site: 'packages/knowledge-local/src/entity-index/entity-index.ts', name: 'ENTITY_INDEX_USER_VERSION', field: 'user_version', value: 2, rule: 'refuse' },
  { id: 'authored-checkpoint', site: 'packages/knowledge-local/src/curator/author-contract.ts', name: 'AUTHORED_CHECKPOINT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'bundle-mutation-journal', site: 'packages/knowledge-local/src/journal/bundle-mutation.ts', name: 'BUNDLE_MUTATION_JOURNAL_VERSION', field: 'version', value: 2, rule: 'refuse' },
  { id: 'commit-intent', site: 'packages/knowledge-local/src/journal/intent-journal.ts', name: 'COMMIT_INTENT_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'rebuild' },
  { id: 'curation-job-state', site: 'packages/knowledge-local/src/queue/job-state.ts', name: 'CURATION_JOB_STATE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'rebuild' },
  { id: 'curation-quarantine-reason', site: 'packages/knowledge-local/src/queue/curation-queue.ts', name: 'CURATION_QUARANTINE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'no-reader' },
  { id: 'curation-queue-payload', site: 'packages/knowledge-local/src/queue/queue-payload.ts', name: 'CURATION_QUEUE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'quarantine-ledger', site: 'packages/schema/src/quarantine/quarantine-ledger.ts', name: 'CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'cassette', site: 'packages/eval/src/cassette/cassette.ts', name: 'CASSETTE_SCHEMA_VERSION', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'records-inspect-output', site: 'packages/schema/src/knowledge/review-verbs.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'records-diff-output', site: 'packages/schema/src/knowledge/review-verbs.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'record-show-output', site: 'packages/schema/src/knowledge/review-verbs.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'record-show-not-found', site: 'packages/schema/src/knowledge/review-verbs.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'recorded-retrieval-rung', site: 'packages/schema/src/brief/retrieval-rung.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'post-verdict-continuation', site: 'packages/cli/src/curation/post-verdict-continuation.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'mark-edit-record', site: 'packages/cli/src/gates/mark-edit-record.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'mark-intent', site: 'packages/agent-local/src/store/mark-ledger.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'mark-lock-owner', site: 'packages/agent-local/src/store/mark-lock.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'scoring-context', site: 'packages/eval/src/match/scoring-context.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'curation-observation', site: 'packages/knowledge-local/src/journal/curation-effect-receipt.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'curation-effect-receipt', site: 'packages/knowledge-local/src/journal/curation-effect-receipt.ts', field: 'schemaVersion', value: 2, rule: 'refuse' },
  { id: 'skills-contracts', site: 'skills/agent-qa-authoring/references/agent-qa-contracts.json', field: 'version', value: 2, rule: 'no-reader', copies: [{ site: 'packages/cli/skills/agent-qa-authoring/references/agent-qa-contracts.json', spelling: '"version": ' }] },
]

export const INLINE_STAMPS: readonly InlineStamp[] = [
  { site: 'packages/agent-local/src/store/mark-ledger.ts', literal: 2, count: 2, id: 'mark-intent' },
  { site: 'packages/agent-local/src/store/mark-lock.ts', literal: 2, count: 2, id: 'mark-lock-owner' },
  { site: 'packages/agent/src/functions/ops/knowledge-records-diff.ts', literal: 2, count: 1, id: 'records-diff-output' },
  { site: 'packages/agent/src/functions/ops/knowledge-records-inspect.ts', literal: 2, count: 1, id: 'records-inspect-output' },
  { site: 'packages/cli/src/curation/post-verdict-continuation.ts', literal: 2, count: 2, id: 'post-verdict-continuation' },
  { site: 'packages/cli/src/gates/mark-edit-record.ts', literal: 2, count: 2, id: 'mark-edit-record' },
  { site: 'packages/eval/src/match/scoring-context.ts', literal: 2, count: 2, id: 'scoring-context' },
  { site: 'packages/knowledge-local/src/curator/commit.ts', literal: 2, count: 1, id: 'curation-observation' },
  { site: 'packages/knowledge-local/src/journal/curation-effect-receipt.ts', literal: 2, count: 1, id: 'curation-observation' },
  { site: 'packages/knowledge-local/src/journal/curation-effect-receipt.ts', literal: 2, count: 1, id: 'curation-effect-receipt' },
  { site: 'packages/knowledge-local/src/retrieval-rung.ts', literal: 2, count: 5, id: 'recorded-retrieval-rung' },
  { site: 'packages/knowledge-local/src/show-records.ts', literal: 2, count: 1, id: 'record-show-output' },
  { site: 'packages/knowledge-local/src/show-records.ts', literal: 2, count: 1, id: 'record-show-not-found' },
  { site: 'packages/schema/src/brief/retrieval-rung.ts', literal: 2, count: 1, id: 'recorded-retrieval-rung' },
  { site: 'packages/schema/src/knowledge/review-verbs.ts', literal: 2, count: 1, id: 'records-inspect-output' },
  { site: 'packages/schema/src/knowledge/review-verbs.ts', literal: 2, count: 1, id: 'records-diff-output' },
  { site: 'packages/schema/src/knowledge/review-verbs.ts', literal: 2, count: 1, id: 'record-show-output' },
  { site: 'packages/schema/src/knowledge/review-verbs.ts', literal: 2, count: 1, id: 'record-show-not-found' },
]

export const JSON_STAMPS: readonly JsonStamp[] = [
  { file: 'skills/agent-qa-authoring/references/agent-qa-contracts.json', key: 'version', value: 2 },
  { file: 'packages/cli/skills/agent-qa-authoring/references/agent-qa-contracts.json', key: 'version', value: 2 },
]

export const FIXTURE_STAMP_EXCLUSIONS: readonly FixtureStampExclusion[] = [
  { file: 'packages/cli/src/__tests__/fixtures/legacy-config-proposal.json', reason: 'Bytes of the retired config proposal format, read only by an attribution test; no current format carries this stamp.' },
]

export const VERSION_EXCLUSIONS: readonly VersionExclusion[] = [
  { site: 'packages/mcp/src/app-wrapper.ts', name: 'APP_WRAPPER_UI_PROTOCOL_VERSION', category: 'external-spec', reason: 'The MCP Apps UI protocol version is set by that specification, not by agent-qa.' },
  { site: 'packages/schema/src/functions/output-contract.ts', name: '~standard', category: 'external-spec', reason: 'The Standard Schema interface version is set by the Standard Schema specification.' },
  { site: 'packages/mcp/src/projection.ts', name: 'JSON_SCHEMA_CONVERSION_TARGET', category: 'external-spec', reason: 'The JSON-Schema draft names the external dialect the projection emits.' },
  { site: 'knip.json', name: '$schema', category: 'external-spec', reason: 'A JSON-Schema URI published by the tool that reads the file.' },
  { site: 'glama.json', name: '$schema', category: 'external-spec', reason: 'A JSON-Schema URI published by the registry that reads the file.' },
  { site: 'packages/knowledge-local/assets/potion-retrieval-32m/tokenizer.json', name: '"version"', category: 'external-spec', reason: 'The tokenizer file format belongs to the Hugging Face tokenizers library.' },
  { site: 'packages/model/src/middleware.ts', name: 'specificationVersion', category: 'external-spec', reason: 'The AI SDK middleware specification version is set by the AI SDK.' },
  { site: 'packages/core/src/version.ts', name: 'AGENT_QA_VERSION', category: 'package-version', reason: 'The package version is set by the release, not by a document format.' },
  { site: 'packages/cli/src/composition/analytics-host.ts', name: 'CLI_ANALYTICS_AGENT_QA_VERSION', category: 'package-version', reason: 'The CLI package version is set by the release, not by a document format.' },
  { site: 'packages/cli/src/index.ts', name: 'VERSION', category: 'package-version', reason: 'The CLI package version is set by the release, not by a document format.' },
  { site: 'packages/mcp/src/catalog.ts', name: 'AGENT_QA_MCP_SERVER_VERSION', category: 'package-version', reason: 'The MCP server version is a product version reported to clients.' },
  { site: 'packages/mcp/src/app-wrapper.ts', name: 'APP_WRAPPER_APP_VERSION', category: 'package-version', reason: 'The app wrapper version is a product version reported to MCP hosts.' },
  { site: 'packages/agent/src/chat/scenarios/manifest.ts', name: 'SCENARIO_CORPUS_VERSION', category: 'content-version', reason: 'It names the scenario corpus content, not the shape of a stored document.' },
  { site: 'packages/cli/src/curation/emit-candidates.ts', name: 'PROCEDURE_TRAJECTORY_SEED_VERSION', category: 'content-version', reason: 'It seeds procedure trajectory identities, so changing it re-keys them.' },
  { site: 'packages/dashboard-ui/src/lib/product-tour-state.ts', name: 'PRODUCT_TOUR_VERSION', category: 'content-version', reason: 'It names the tour content shown, not the cookie format.' },
  { site: 'packages/schema/src/verdict/action-anchor-fingerprint.ts', name: 'ACTION_ANCHOR_FINGERPRINT_VERSION', category: 'content-version', reason: 'It feeds action anchor fingerprints, so changing it re-keys them.' },
  { site: 'packages/eval/src/match/config.ts', name: 'matcherVersion', category: 'content-version', reason: 'It identifies the matcher configuration that a score was computed with.' },
  { site: 'packages/eval/src/judge/config.ts', name: 'judgeVersion', category: 'content-version', reason: 'It identifies the judge configuration that a verdict was computed with.' },
  { site: 'packages/knowledge-local/src/index-open.ts', name: 'EMBEDDING_VEC_CLEANUP_EPOCH', category: 'content-version', reason: 'It is a one-time cleanup epoch for derived embeddings, not a format stamp.' },
  { site: 'packages/knowledge-local/src/index-open.ts', name: 'EMBEDDING_TRANSITION_EPOCH', category: 'content-version', reason: 'It is a one-time transition epoch for derived embeddings, not a format stamp.' },
  { site: 'packages/schema/src/determinism/screen-hash.ts', name: 'screen-state:v1', category: 'domain-tag', reason: 'A hash domain tag; changing it re-keys every screen hash.' },
  { site: 'packages/schema/src/determinism/screen-hash.ts', name: 'screen-identity:v1', category: 'domain-tag', reason: 'A hash domain tag; changing it re-keys every screen identity.' },
  { site: 'packages/schema/src/brief/compute-brief-digest.ts', name: 'served-brief:v1', category: 'domain-tag', reason: 'A hash domain tag; changing it re-keys every served-brief digest.' },
  { site: 'packages/runner/src/cache/key.ts', name: 'agent-qa/cache/env-digest/v1', category: 'domain-tag', reason: 'A hash salt; changing it re-keys every action cache key.' },
  { site: 'packages/knowledge-local/src/retrieval/fts-match.ts', name: 'quoted-token-or-v1', category: 'domain-tag', reason: 'It names the lexical match semantics that retrieval thresholds were calibrated on.' },
  { site: 'packages/knowledge-local/src/embedder-floor.ts', name: 'FLOOR_FORMAT_VERSION', category: 'floor-asset', reason: 'The bundled floor model binary carries this header value, and its bytes are pinned by sha256.' },
  { site: 'packages/knowledge-local/src/embedder-floor.ts', name: 'schemaVersion', category: 'floor-asset', reason: 'The exact check on the bundled floor manifest, which is not regenerated.', inline: { literal: 1, count: 1 } },
  { site: 'packages/knowledge-local/assets/potion-retrieval-32m/manifest.json', name: '"schemaVersion"', category: 'floor-asset', reason: 'The bundled floor manifest pins the model binary by sha256 and is not regenerated.' },
  { site: 'packages/knowledge-local/assets/potion-retrieval-32m/golden-vectors.json', name: '"schemaVersion"', category: 'floor-asset', reason: 'The golden vectors are pinned evidence for the bundled floor model.' },
  { site: 'scripts/413-migrate-handoff-paths.mjs', name: 'schemaVersion', category: 'historical-script', reason: 'A one-shot path migration kept as history; the release does not run it.' },
  { site: 'scripts/415-classifier-repeatability.mjs', name: 'schemaVersion', category: 'historical-script', reason: 'A one-shot measurement script kept as history; the release does not run it.' },
  { site: 'packages/knowledge-local/src/rebuild-marker.ts', name: "'schema-version'", category: 'label', reason: 'A rebuild-reason label that names why an index was rebuilt; it carries no value.' },
  { site: 'packages/knowledge-local/src/index-open.ts', name: "'schema-version'", category: 'label', reason: 'A health-probe label that names the failed probe; it carries no value.' },
]
