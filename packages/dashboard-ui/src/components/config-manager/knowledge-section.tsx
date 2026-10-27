import { ConfigField } from "@/components/config-manager/config-field"
import { DataPathField } from "@/components/config-manager/data-path-field"
import {
  KNOWLEDGE_COMMIT_ARTIFACTS_LABELS,
  KNOWLEDGE_FIELD_HELP,
  KNOWLEDGE_FIELD_LABELS,
} from "@/lib/config-copy"

const COMMIT_ARTIFACTS_OPTIONS = Object.entries(KNOWLEDGE_COMMIT_ARTIFACTS_LABELS).map(([value, label]) => ({
  value,
  label,
}))

export function KnowledgeSection() {
  return (
    <>
      <DataPathField
        field={{ segments: ["knowledge", "dir"], tab: "project", pattern: "knowledge.dir" }}
        label={KNOWLEDGE_FIELD_LABELS.dir}
        explicitKind="change-knowledge-dir"
        help={KNOWLEDGE_FIELD_HELP.dir}
        placeholder="agent-qa-knowledge"
      />
      <ConfigField
        field={{ segments: ["knowledge", "commitArtifacts"], tab: "project", pattern: "knowledge.commitArtifacts" }}
        label={KNOWLEDGE_FIELD_LABELS.commitArtifacts}
        kind="select"
        options={COMMIT_ARTIFACTS_OPTIONS}
        placeholder={KNOWLEDGE_COMMIT_ARTIFACTS_LABELS.none}
      />
    </>
  )
}
