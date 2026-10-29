import { ConfigField } from "@/components/config-manager/config-field"
import { DataPathField } from "@/components/config-manager/data-path-field"
import { DASHBOARD_FIELD_HELP, DASHBOARD_FIELD_LABELS, PORT_RESTART_HELP } from "@/lib/config-copy"

export function DashboardSection() {
  return (
    <>
      <ConfigField
        field={{ segments: ["services", "dashboard", "port"], tab: "project", pattern: "services.dashboard.port" }}
        label={DASHBOARD_FIELD_LABELS.port}
        kind="number"
        help={PORT_RESTART_HELP}
        placeholder="3470"
        number={{ min: 1, max: 65535, integer: true }}
      />
      <ConfigField
        field={{ segments: ["services", "dashboard", "host"], tab: "project", pattern: "services.dashboard.host" }}
        label={DASHBOARD_FIELD_LABELS.host}
        kind="text"
        help={DASHBOARD_FIELD_HELP.host}
        placeholder="127.0.0.1"
      />
      <DataPathField
        field={{ segments: ["services", "dashboard", "dbPath"], tab: "project", pattern: "services.dashboard.dbPath" }}
        label={DASHBOARD_FIELD_LABELS.dbPath}
        explicitKind="change-db-path"
        placeholder=".agent-qa/runs.db"
      />
      <DataPathField
        field={{
          segments: ["services", "dashboard", "artifactsDir"],
          tab: "project",
          pattern: "services.dashboard.artifactsDir",
        }}
        label={DASHBOARD_FIELD_LABELS.artifactsDir}
        explicitKind="change-artifacts-dir"
        placeholder=".agent-qa/artifacts"
      />
      <ConfigField
        field={{ segments: ["services", "dashboard", "baseUrl"], tab: "project", pattern: "services.dashboard.baseUrl" }}
        label={DASHBOARD_FIELD_LABELS.baseUrl}
        kind="text"
        help={DASHBOARD_FIELD_HELP.baseUrl}
        placeholder="http://localhost:3470"
      />
      <ConfigField
        field={{
          segments: ["services", "dashboard", "workspace"],
          tab: "project",
          pattern: "services.dashboard.workspace",
        }}
        label={DASHBOARD_FIELD_LABELS.workspace}
        kind="text"
        help={DASHBOARD_FIELD_HELP.workspace}
      />
    </>
  )
}
