export {
  describePlugin,
  type PluginDescription,
  type PluginField,
} from './describe.js'
export { isNpmPackageName, pluginsAddLine } from '../plugin-loader-util.js'
export {
  readPluginManifest,
  SUBSCRIPTION_AUTH_PACKAGE,
  type PluginManifestRead,
} from './manifest.js'
export {
  checkPluginConfig,
  MAX_PLUGIN_SCHEMA_BYTES,
  MAX_PLUGIN_SCHEMA_DEPTH,
  type PluginConfigInput,
  type PluginConfigIssue,
} from './options-check.js'
export {
  pluginRemoteRefusals,
  type PluginRemoteRefusal,
  type PluginRemoteRefusalsInput,
  type PluginRemoteUse,
} from './run-start.js'
export {
  pluginInstallLine,
  resolvePluginEntries,
  resolvePluginEntry,
  selectInProcessPluginEntries,
  supportedPluginProtocols,
  type InProcessPluginKind,
  type InProcessRefusal,
  type InProcessSelection,
  type PluginEntryInput,
  type PluginEntryState,
  type PluginOrigin,
  type PluginRemoteInput,
  type ResolvedPluginEntry,
  type ResolvePluginEntryOptions,
} from './resolve-entries.js'
export {
  validatePluginPackage,
  type PluginPackageCheck,
  type PluginPackageReport,
  type ValidatePluginPackageOptions,
} from './validate-package.js'
