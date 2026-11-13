// An entry waives one exact (file, specifier) pair, and a cleared entry fails as stale.
export interface SurfaceLedgerEntry {
  /** Repo-relative path, forward slashes, exact — no directory prefixes. */
  file: string
  /** The exact import specifier as written, including any subpath. */
  specifier: string
  /** The phase or milestone whose completion deletes this entry. */
  clearedBy: string
  /** Why the pair exists today and what supersedes it. */
  reason: string
}

export function surfaceLedgerKey(entry: Pick<SurfaceLedgerEntry, 'file' | 'specifier'>): string {
  return `${entry.file.replaceAll('\\', '/')} :: ${entry.specifier}`
}

export const SURFACE_FIREWALL_LEDGER: readonly SurfaceLedgerEntry[] = [
  {
    file: 'packages/cli/src/commands/agent-qa-upgrade.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "init's version moves name their breaking steps with core's semver helpers; joins the config mutation class with init",
  },
  {
    file: 'packages/cli/src/commands/auth-state.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'auth-state inspection reads resolved config directly; moves behind the typed config action class',
  },
  {
    file: 'packages/cli/src/commands/auth.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'auth command mutates provider credentials in place; superseded by the config/environment mutation class',
  },
  {
    file: 'packages/cli/src/commands/auth.ts',
    specifier: '@vostride/agent-qa-model',
    clearedBy: '395',
    reason: 'auth command mutates provider credentials in place; superseded by the config/environment mutation class',
  },
  {
    file: 'packages/cli/src/commands/baseline-probe.ts',
    specifier: '@vostride/agent-qa-runner',
    clearedBy: '386',
    reason: 'probe builds a run session in-process; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/browser-resolver.ts',
    specifier: '@vostride/agent-qa-web',
    clearedBy: '395',
    reason: "browser installation and doctor's Chromium check resolve the web package's playwright-core on the host; joins the environment action class",
  },
  {
    file: 'packages/cli/src/commands/cache.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'model/response cache administration over host paths; joins the config and environment action class',
  },
  {
    file: 'packages/cli/src/commands/config-model-edit.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "init's re-run checks its model edit of the config with core's config schema before writing; joins the config mutation class with init",
  },
  {
    file: 'packages/cli/src/commands/dashboard.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: 'M5',
    reason: 'dashboard spawn and asset resolution; rewired when the dashboards themselves enter the firewall in M5',
  },
  {
    file: 'packages/cli/src/commands/dashboard.ts',
    specifier: '@vostride/agent-qa-dashboard',
    clearedBy: 'M5',
    reason: 'dashboard spawn and asset resolution; rewired when the dashboards themselves enter the firewall in M5',
  },
  {
    file: 'packages/cli/src/commands/dashboard.ts',
    specifier: '@vostride/agent-qa-dashboard-ui/package.json',
    clearedBy: 'M5',
    reason: 'dashboard spawn and asset resolution; rewired when the dashboards themselves enter the firewall in M5',
  },
  {
    file: 'packages/cli/src/commands/dashboard.ts',
    specifier: '@vostride/agent-qa-model',
    clearedBy: 'M5',
    reason: 'dashboard spawn and asset resolution; rewired when the dashboards themselves enter the firewall in M5',
  },
  {
    file: 'packages/cli/src/commands/direct-run-members.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '386',
    reason: 'direct run member assembly; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/direct-run-members.ts',
    specifier: '@vostride/agent-qa-runner',
    clearedBy: '386',
    reason: 'direct run member assembly; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/doctor-device-checks.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "doctor's device rows read the config's device profiles as agent-qa devices does; joins the environment action class",
  },
  {
    file: 'packages/cli/src/commands/doctor-plugin-checks.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "doctor's plugin rows resolve plugins entries and run each plugin's account check through core's plugin host pool directly; joins the environment action class",
  },
  {
    file: 'packages/cli/src/commands/doctor-setup-checks.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "doctor's newer-version row checks the registry's answer with core's semver helper before it reaches a message or a link; joins the environment action class",
  },
  {
    file: 'packages/cli/src/commands/doctor.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'environment diagnosis probes hosts and model config directly; joins the environment action class',
  },
  {
    file: 'packages/cli/src/commands/doctor.ts',
    specifier: '@vostride/agent-qa-model',
    clearedBy: '395',
    reason: 'environment diagnosis probes hosts and model config directly; joins the environment action class',
  },
  {
    file: 'packages/cli/src/commands/doctor.ts',
    specifier: '@vostride/agent-qa-runner-local',
    clearedBy: '395',
    reason: 'environment diagnosis probes hosts and model config directly; joins the environment action class',
  },
  {
    file: 'packages/cli/src/commands/init.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'project scaffolding writes config and model defaults; joins the config mutation class',
  },
  {
    file: 'packages/cli/src/commands/init.ts',
    specifier: '@vostride/agent-qa-model',
    clearedBy: '395',
    reason: 'project scaffolding writes config and model defaults; joins the config mutation class',
  },
  {
    file: 'packages/cli/src/commands/init-model-choice.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'project scaffolding writes config and model defaults; joins the config mutation class',
  },
  {
    file: 'packages/cli/src/commands/init-model-choice.ts',
    specifier: '@vostride/agent-qa-model',
    clearedBy: '395',
    reason: 'project scaffolding writes config and model defaults; joins the config mutation class',
  },
  {
    file: 'packages/cli/src/commands/init-rerun.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "init's re-run reads the auth store's path from core to report the model's status; joins the config mutation class with init",
  },
  {
    file: 'packages/cli/src/commands/latest-version-ask.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "init and doctor ask for the latest agent-qa with core's registry ask under the CLI's deadline; joins the config mutation class with init",
  },
  {
    file: 'packages/cli/src/commands/mcp.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '396',
    reason: 'the MCP server reports the running agent-qa version as its server version',
  },
  {
    file: 'packages/cli/src/commands/mcp.ts',
    specifier: '@vostride/agent-qa-mcp',
    clearedBy: '396',
    reason: 'spawns the v1 MCP server; rewritten with the SDK re-derivation',
  },
  {
    file: 'packages/cli/src/commands/package-install.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "init's install step orders installed versions with core's semver helpers; joins the config mutation class with init",
  },
  {
    file: 'packages/cli/src/commands/package-json-plan.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "init's package.json plan reads the running agent-qa version from core; joins the config mutation class with init",
  },
  {
    file: 'packages/cli/src/commands/package-manager.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "manager detection reads Yarn's line from a declared range's floor with core's semver helper; joins the config mutation class with init",
  },
  {
    file: 'packages/cli/src/commands/plugin-remote-refusals.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '386',
    reason: 'the run command keeps its plugin remote refusals here, split out of run.ts; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/plugin-remote-refusals.ts',
    specifier: '@vostride/agent-qa-runner',
    clearedBy: '386',
    reason: 'the run command keeps its plugin remote refusals here, split out of run.ts; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/plugins-add.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'plugins add checks the package name and writes the plugins entry with core schemas directly; joins the typed config action class',
  },
  {
    file: 'packages/cli/src/commands/plugins.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'plugins list, describe and validate read plugin entries, manifests and shipped schemas through core directly; joins the typed config action class',
  },
  {
    file: 'packages/cli/src/commands/project-agent-qa.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "the hand-off to the project's agent-qa compares versions and checks its bin path with core helpers; joins the config mutation class with init",
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    specifier: '@vostride/agent-qa-android',
    clearedBy: '386',
    reason: 'the run command wires runner, safety, and every platform driver by hand; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '386',
    reason: 'the run command wires runner, safety, and every platform driver by hand; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    specifier: '@vostride/agent-qa-dashboard',
    clearedBy: '386',
    reason: 'the run command wires runner, safety, and every platform driver by hand; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    specifier: '@vostride/agent-qa-ios',
    clearedBy: '386',
    reason: 'the run command wires runner, safety, and every platform driver by hand; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    specifier: '@vostride/agent-qa-model',
    clearedBy: '386',
    reason: 'the run command wires runner, safety, and every platform driver by hand; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    specifier: '@vostride/agent-qa-runner',
    clearedBy: '386',
    reason: 'the run command wires runner, safety, and every platform driver by hand; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    specifier: '@vostride/agent-qa-runner-local',
    clearedBy: '386',
    reason: 'the run command wires runner, safety, and every platform driver by hand; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/run.ts',
    specifier: '@vostride/agent-qa-web',
    clearedBy: '386',
    reason: 'the run command wires runner, safety, and every platform driver by hand; relocates with the run-session composition root',
  },
  {
    file: 'packages/cli/src/commands/setup-rows.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "the re-run's setup rows resolve the config's workspace files with core's resolver; joins the config mutation class with init",
  },
  {
    file: 'packages/cli/src/commands/skill-install.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "the skills installer resolves each plugins entry's package and checks its skill path with core's plugin resolver; joins the config mutation class with init",
  },
  {
    file: 'packages/cli/src/commands/validate.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'config and suite validation reads resolved config directly; joins the config action class',
  },
  {
    file: 'packages/cli/src/commands/web-placement.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "doctor and the browsers row read where every web test runs from the workspace's test and suite files; joins the environment action class",
  },
  {
    // The one host loader for `workspace.secretsFile`, shared with `agent-qa run`.
    file: 'packages/cli/src/composition/declared-secrets.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'the declared-secrets loader resolves the workspace secrets path directly; joins the typed config action class with local-agent-host.ts',
  },
  {
    file: 'packages/cli/src/composition/declared-secrets.ts',
    specifier: '@vostride/agent-qa-runner',
    clearedBy: '395',
    reason: 'the declared-secrets loader builds the one masking function (SecretRedactor) the run uses; joins the typed config action class with local-agent-host.ts',
  },
  {
    file: 'packages/cli/src/composition/local-agent-host.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'the CLI half of the local host resolves and masks configuration directly; joins the typed config action class',
  },
  {
    // Reaches the dashboard's config transaction so the dashboard and this writer share one path.
    file: 'packages/cli/src/composition/local-agent-host.ts',
    specifier: '@vostride/agent-qa-dashboard',
    clearedBy: 'M5',
    reason: 'the direct config writer shares the dashboard config transaction; rewired when the dashboards enter the firewall in M5',
  },
  {
    file: 'packages/cli/src/composition/plugin-host.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: "the run's plugin host composes core's plugin host pool with the config's plugins entries, core's host versions and secret resolver; joins the typed config action class",
  },
  {
    file: 'packages/cli/src/composition/plugin-host.ts',
    specifier: '@vostride/agent-qa-runner',
    clearedBy: '395',
    reason: "the run's plugin host types its declared secrets and session registry with the runner's ports; joins the typed config action class",
  },
  {
    file: 'packages/cli/src/composition/process-appium.ts',
    specifier: '@vostride/agent-qa-dashboard',
    clearedBy: 'M5',
    reason: "the module holds the process's Appium manager, the dashboard package's class, shared by the run, daemon, MCP and dashboard hosts; rewired when the dashboards enter the firewall in M5",
  },
  {
    // Moved out of run.ts so the daemon and MCP hosts release sessions without loading the run.
    file: 'packages/cli/src/composition/remote-sessions.ts',
    specifier: '@vostride/agent-qa-runner',
    clearedBy: '386',
    reason: "the process's remote-session registry, shared by the run, daemon and MCP hosts; relocates with the run-session composition root",
  },
  {
    file: 'packages/cli/src/config.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'CLI config resolution helper; joins the typed config action class',
  },
  {
    file: 'packages/cli/src/curation/authoring-test-discovery.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '388',
    reason: 'authoring-side test discovery in the curation pipeline; moves behind the analyze-run job chain',
  },
  {
    file: 'packages/cli/src/curation/curation-tail.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '388',
    reason: 'the post-run curation tail runs in-process today; moves behind the analyze-run job chain',
  },
  {
    file: 'packages/cli/src/curation/curation-tail.ts',
    specifier: '@vostride/agent-qa-runner',
    clearedBy: '388',
    reason: 'the post-run curation tail runs in-process today; moves behind the analyze-run job chain',
  },
  {
    file: 'packages/cli/src/curation/curation-tail.ts',
    specifier: '@vostride/agent-qa-runner-local',
    clearedBy: '388',
    reason: 'the post-run curation tail runs in-process today; moves behind the analyze-run job chain',
  },
  {
    file: 'packages/cli/src/curation/curation-tail.ts',
    specifier: '@vostride/agent-qa-safety-local',
    clearedBy: '388',
    reason: 'the post-run curation tail runs in-process today; moves behind the analyze-run job chain',
  },
  {
    file: 'packages/cli/src/curation/curator-author.ts',
    specifier: '@vostride/agent-qa-model',
    clearedBy: '388',
    reason: 'curator authoring pass over the knowledge store; moves behind the curate-memory job',
  },
  {
    file: 'packages/cli/src/curation/emit-candidates.ts',
    specifier: '@vostride/agent-qa-runner-local',
    clearedBy: '388',
    reason: 'candidate emission writes knowledge directly; moves behind the curate-memory job',
  },
  {
    file: 'packages/cli/src/eval-report-render.ts',
    specifier: '@vostride/agent-qa-eval',
    clearedBy: '386',
    reason: 'eval report rendering types against the eval package; relocates with the eval session composition',
  },
  {
    file: 'packages/cli/src/eval-session-composition.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '386',
    reason: 'the eval session composition root; superseded by composeLocalAgent()',
  },
  {
    file: 'packages/cli/src/eval-session-composition.ts',
    specifier: '@vostride/agent-qa-eval',
    clearedBy: '386',
    reason: 'the eval session composition root; superseded by composeLocalAgent()',
  },
  {
    file: 'packages/cli/src/eval-session-composition.ts',
    specifier: '@vostride/agent-qa-eval-local',
    clearedBy: '386',
    reason: 'the eval session composition root; superseded by composeLocalAgent()',
  },
  {
    file: 'packages/cli/src/eval-session-composition.ts',
    specifier: '@vostride/agent-qa-model',
    clearedBy: '386',
    reason: 'the eval session composition root; superseded by composeLocalAgent()',
  },
  {
    file: 'packages/cli/src/eval-session-composition.ts',
    specifier: '@vostride/agent-qa-runner',
    clearedBy: '386',
    reason: 'the eval session composition root; superseded by composeLocalAgent()',
  },
  {
    file: 'packages/cli/src/eval-session-composition.ts',
    specifier: '@vostride/agent-qa-runner-local',
    clearedBy: '386',
    reason: 'the eval session composition root; superseded by composeLocalAgent()',
  },
  {
    file: 'packages/cli/src/eval-session-composition.ts',
    specifier: '@vostride/agent-qa-safety-local',
    clearedBy: '386',
    reason: 'the eval session composition root; superseded by composeLocalAgent()',
  },
  {
    file: 'packages/cli/src/index.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '386',
    reason: 'the CLI entry still resolves host paths itself; relocates with the composition root',
  },
  {
    file: 'packages/cli/src/llm-utils.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'model client construction over resolved config; joins the config action class',
  },
  {
    file: 'packages/cli/src/llm-utils.ts',
    specifier: '@vostride/agent-qa-model',
    clearedBy: '395',
    reason: 'model client construction over resolved config; joins the config action class',
  },
  {
    file: 'packages/cli/src/provider-plugins.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'provider plugin loading over resolved config; joins the config action class',
  },
  {
    file: 'packages/cli/src/provider-plugins.ts',
    specifier: '@vostride/agent-qa-model',
    clearedBy: '395',
    reason: 'provider plugin loading over resolved config; joins the config action class',
  },
  {
    file: 'packages/cli/src/targets.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '395',
    reason: 'target resolution over host config; joins the environment action class',
  },
  {
    file: 'packages/cli/src/version-notice.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '386',
    reason: 'version notice reads host state directly; relocates with the composition root',
  },
  {
    file: 'packages/cli/src/version-refresh.ts',
    specifier: '@vostride/agent-qa-core',
    clearedBy: '386',
    reason: 'the detached registry refresh writes the version-check cache directly; relocates with the version notice',
  },
]
