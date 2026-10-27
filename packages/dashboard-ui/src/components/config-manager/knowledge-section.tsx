import { DataPathField } from "@/components/config-manager/data-path-field"
import { KNOWLEDGE_FIELD_HELP, KNOWLEDGE_FIELD_LABELS } from "@/lib/config-copy"

export function KnowledgeSection() {
  return (
    <DataPathField
      field={{ segments: ["knowledge", "dir"], tab: "project", pattern: "knowledge.dir" }}
      label={KNOWLEDGE_FIELD_LABELS.dir}
      explicitKind="change-knowledge-dir"
      help={KNOWLEDGE_FIELD_HELP.dir}
      placeholder="agent-qa-knowledge"
    />
  )
}
