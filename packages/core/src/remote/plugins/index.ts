export { checkPluginAnswer, type PluginAnswerContext } from './answer.js'
export {
  PLUGIN_ENVIRONMENT_NAMES,
  PLUGIN_WINDOWS_ENVIRONMENT_NAMES,
  pluginEnvironment,
} from './environment.js'
export {
  createPluginHostPool,
  DEFAULT_PLUGIN_HOST_BOUNDS,
  type PluginCheckRemote,
  type PluginHostBounds,
  type PluginHostPool,
  type PluginHostPoolInput,
  type PluginHostProgress,
  type PluginUploadRequest,
} from './host-pool.js'
export {
  installedPackageVersion,
  pluginHostVersions,
  type PluginHostVersions,
} from './host-versions.js'
export { pluginSecretResolver } from './secret-references.js'
