import { AGENT_QA_AGENT_OWNERSHIP_CONTRACT } from '../../agent/src/ownership-contract.js'
import { AGENT_QA_AGENT_LOCAL_OWNERSHIP_CONTRACT } from '../../agent-local/src/ownership-contract.js'
import { AGENT_QA_ANALYTICS_OWNERSHIP_CONTRACT } from '../../analytics/src/ownership-contract.js'
import { AGENT_QA_ANDROID_OWNERSHIP_CONTRACT } from '../../android/src/ownership-contract.js'
import { AGENT_QA_CLI_OWNERSHIP_CONTRACT } from '../../cli/src/ownership-contract.js'
import { AGENT_QA_CORE_OWNERSHIP_CONTRACT } from '../../core/src/ownership-contract.js'
import { AGENT_QA_DASHBOARD_OWNERSHIP_CONTRACT } from '../../dashboard-server/src/ownership-contract.js'
import { AGENT_QA_DASHBOARD_UI_OWNERSHIP_CONTRACT } from '../../dashboard-ui/src/ownership-contract.js'
import { AGENT_QA_EVAL_OWNERSHIP_CONTRACT } from '../../eval/src/ownership-contract.js'
import { AGENT_QA_EVAL_LOCAL_OWNERSHIP_CONTRACT } from '../../eval-local/src/ownership-contract.js'
import { AGENT_QA_IDS_OWNERSHIP_CONTRACT } from '../../ids/src/ownership-contract.js'
import { AGENT_QA_IOS_OWNERSHIP_CONTRACT } from '../../ios/src/ownership-contract.js'
import { AGENT_QA_KNOWLEDGE_LOCAL_OWNERSHIP_CONTRACT } from '../../knowledge-local/src/ownership-contract.js'
import { AGENT_QA_MCP_OWNERSHIP_CONTRACT } from '../../mcp/src/ownership-contract.js'
import { AGENT_QA_MODEL_OWNERSHIP_CONTRACT } from '../../model/src/ownership-contract.js'
import { AGENT_QA_RUNNER_OWNERSHIP_CONTRACT } from '../../runner/src/ownership-contract.js'
import { AGENT_QA_RUNNER_LOCAL_OWNERSHIP_CONTRACT } from '../../runner-local/src/ownership-contract.js'
import { AGENT_QA_SAFETY_OWNERSHIP_CONTRACT } from '../../safety/src/ownership-contract.js'
import { AGENT_QA_SAFETY_LOCAL_OWNERSHIP_CONTRACT } from '../../safety-local/src/ownership-contract.js'
import { AGENT_QA_SCHEMA_OWNERSHIP_CONTRACT } from '../../schema/src/ownership-contract.js'
import { AGENT_QA_WEB_OWNERSHIP_CONTRACT } from '../../web/src/ownership-contract.js'
import { PACKAGE_CLASS_RULES } from './contract-types.js'
import type { OwnershipContract } from './contract-types.js'
import { AGENT_QA_ARCH_OWNERSHIP_CONTRACT } from './ownership-contract.js'

export const ARCH_MANIFEST = {
  packages: [
    AGENT_QA_ARCH_OWNERSHIP_CONTRACT,
    AGENT_QA_AGENT_OWNERSHIP_CONTRACT,
    AGENT_QA_AGENT_LOCAL_OWNERSHIP_CONTRACT,
    AGENT_QA_SCHEMA_OWNERSHIP_CONTRACT,
    AGENT_QA_MODEL_OWNERSHIP_CONTRACT,
    AGENT_QA_RUNNER_OWNERSHIP_CONTRACT,
    AGENT_QA_SAFETY_OWNERSHIP_CONTRACT,
    AGENT_QA_SAFETY_LOCAL_OWNERSHIP_CONTRACT,
    AGENT_QA_RUNNER_LOCAL_OWNERSHIP_CONTRACT,
    AGENT_QA_KNOWLEDGE_LOCAL_OWNERSHIP_CONTRACT,
    AGENT_QA_CORE_OWNERSHIP_CONTRACT,
    AGENT_QA_IDS_OWNERSHIP_CONTRACT,
    AGENT_QA_WEB_OWNERSHIP_CONTRACT,
    AGENT_QA_ANDROID_OWNERSHIP_CONTRACT,
    AGENT_QA_IOS_OWNERSHIP_CONTRACT,
    AGENT_QA_MCP_OWNERSHIP_CONTRACT,
    // `validate:arch` ranges this array, so an unregistered contract is one nothing checks.
    AGENT_QA_ANALYTICS_OWNERSHIP_CONTRACT,
    AGENT_QA_CLI_OWNERSHIP_CONTRACT,
    AGENT_QA_DASHBOARD_OWNERSHIP_CONTRACT,
    AGENT_QA_DASHBOARD_UI_OWNERSHIP_CONTRACT,
    AGENT_QA_EVAL_OWNERSHIP_CONTRACT,
    AGENT_QA_EVAL_LOCAL_OWNERSHIP_CONTRACT,
  ],
  taxonomy: PACKAGE_CLASS_RULES,
} as const satisfies {
  packages: readonly OwnershipContract[]
  taxonomy: typeof PACKAGE_CLASS_RULES
}
