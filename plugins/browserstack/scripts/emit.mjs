import { emitPluginFiles } from '@vostride/agent-qa-plugin-kit'
import plugin from '../dist/plugin.js'
emitPluginFiles({ definition: plugin, packageDir: process.cwd() })
