import { ConfigField, type ConfigFieldTarget } from "@/components/config-manager/config-field"
import { SecretValue } from "@/components/config-manager/secret-value"
import type { ConfigFieldParse } from "@/hooks/use-config-autosave"
import {
  ENV_FILE_REQUIRED_ERROR,
  FILES_FIELD_HELP,
  FILES_FIELD_LABELS,
  HOOKS_FILE_REQUIRED_ERROR,
} from "@/lib/config-copy"

interface FilesSectionProps {
  config: Record<string, unknown>
}

type FileLeaf = keyof typeof FILES_FIELD_LABELS

function fileField(leaf: FileLeaf): ConfigFieldTarget {
  return { segments: ["workspace", leaf], tab: "project", pattern: `workspace.${leaf}` }
}

// Each path is required by the schema, so an emptied field stays a draft instead of writing.
function requiredText(error: string) {
  return (raw: string): ConfigFieldParse => (raw.trim() === "" ? { valid: false, error } : { valid: true, value: raw })
}

const parseHooksFile = requiredText(HOOKS_FILE_REQUIRED_ERROR())
const parseEnvFile = requiredText(ENV_FILE_REQUIRED_ERROR())

const SECRETS_FILE_LABEL_ID = "config-files-secrets-file-label"
const SECRETS_FILE_HELP_ID = "config-files-secrets-file-help"

function secretsFileOf(config: Record<string, unknown>): string {
  const workspace = config.workspace
  if (typeof workspace !== "object" || workspace === null) return ""
  const value = (workspace as Record<string, unknown>).secretsFile
  return typeof value === "string" ? value : ""
}

export function FilesSection({ config }: FilesSectionProps) {
  return (
    <>
      <ConfigField
        field={fileField("hooksFile")}
        label={FILES_FIELD_LABELS.hooksFile}
        kind="text"
        help={FILES_FIELD_HELP.hooksFile}
        placeholder="tests/hooks.ts"
        parse={parseHooksFile}
      />
      <ConfigField
        field={fileField("envFile")}
        label={FILES_FIELD_LABELS.envFile}
        kind="text"
        help={FILES_FIELD_HELP.envFile}
        placeholder=".env.local"
        parse={parseEnvFile}
      />
      <div
        role="group"
        aria-labelledby={SECRETS_FILE_LABEL_ID}
        aria-describedby={SECRETS_FILE_HELP_ID}
        className="space-y-2"
      >
        <p id={SECRETS_FILE_LABEL_ID} className="text-sm leading-none font-medium">
          {FILES_FIELD_LABELS.secretsFile}
        </p>
        <SecretValue
          field={{ segments: ["workspace", "secretsFile"], pattern: "workspace.secretsFile" }}
          label={FILES_FIELD_LABELS.secretsFile}
          maskedText={secretsFileOf(config)}
        />
        <p id={SECRETS_FILE_HELP_ID} className="text-xs text-muted-foreground break-words">
          {FILES_FIELD_HELP.secretsFile}
        </p>
      </div>
    </>
  )
}
