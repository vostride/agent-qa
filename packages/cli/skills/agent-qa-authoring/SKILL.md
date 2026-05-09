---
name: agent-qa-authoring
description: Use when creating, editing, validating, or running agent-qa tests, suites, or hooks. Prefer agent-qa MCP tools, enforce canonical agent-qa IDs, and use the bundled schema reference to avoid hallucinated config keys or YAML fields.
metadata:
  short-description: Author agent-qa tests safely
---

# agent-qa Authoring

## Workflow

1. Discover the local surface with `agent_qa_discover`.
2. Inspect active config with `agent_qa_get_config`, especially targets, devices, providers, and `services.mcp`.
3. Load `references/agent-qa-contracts.json` when you need exact schema fields or ID contracts.
4. Generate every new ID with agent-qa tooling:
   - MCP: `agent_qa_generate_id`
   - CLI fallback: `agent-qa ids generate <test|suite|hook|run|observation>`
   - npx fallback: `npx --yes agent-qa ids generate <type>`
5. Never hand-write IDs. Validate existing IDs with `agent_qa_validate_id` or `agent-qa ids validate <type> <id> --json`.
6. Validate definitions before saving:
   - Tests: `agent_qa_validate_test` or `agent_qa_validate_definition` with `kind: "test"`
   - Suites: `agent_qa_validate_suite` or `agent_qa_validate_definition` with `kind: "suite"`
   - Hooks: `agent_qa_validate_definition` with `kind: "hooks"`
7. Prefer MCP authoring mutations:
   - Tests: `agent_qa_create_test`, `agent_qa_update_test`, `agent_qa_delete_test`
   - Suites: `agent_qa_create_suite`, `agent_qa_update_suite`, `agent_qa_delete_suite`
   - Hooks: `agent_qa_create_hook`, `agent_qa_update_hook`, `agent_qa_delete_hook`
8. Use CLI/YAML fallback only when MCP is unavailable. Keep file paths matched by `workspace.testMatch` or `workspace.suiteMatch`.

## Required ID Contracts

- Test IDs: `t_` + 10 id-agent words.
- Suite IDs: `s_` + 10 id-agent words.
- Hook IDs: `h_` + 10 id-agent words.
- Run IDs: `r_` + 10 id-agent words.
- Observation IDs: `obs_` + 10 id-agent words.

## Before Running

- Validate YAML first.
- Prefer `agent_qa_enqueue_test_run` and `agent_qa_enqueue_suite_run` over shelling out.
- If using CLI fallback, run only after validation succeeds.

## Do Not

- Do not invent config keys.
- Do not use legacy root config buckets.
- Do not hand-write IDs.
- Do not mutate files outside the configured workspace patterns.
