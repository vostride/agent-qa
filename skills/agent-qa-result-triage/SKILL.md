---
name: agent-qa-result-triage
description: Use when investigating failed agent-qa runs, inspecting artifacts, classifying failures, or comparing recent runs. Prefer agent-qa MCP run/artifact tools and produce evidence-backed triage.
metadata:
  short-description: Triage agent-qa run failures
---

# agent-qa Result Triage

## Workflow

1. Start with `agent_qa_get_run` for run status, suite child context, steps, and attempts.
2. Fetch evidence before deciding:
   - `agent_qa_get_run_artifact`
   - `agent_qa_get_run_steps`
   - `agent_qa_get_run_logs`
   - `agent_qa_get_run_execution_logs`
3. Call `agent_qa_classify_failure` and use its category as the default classification unless stronger evidence contradicts it.
4. Compare recent related runs when available in the classifier output.
5. Return a concise triage result: category, confidence, evidence, likely fix area, and next action.
6. For code changes, switch to `agent-qa-debug-fix` after triage is complete.

## Categories

Use one of the fixed categories from `references/triage-categories.md`:

- `timeout`
- `appium_startup`
- `browser_disconnect`
- `element_not_found`
- `assertion_failure`
- `hook_failure`
- `infrastructure`
- `unknown_failure`

## Evidence Rules

- Quote or summarize concrete artifact/log/step evidence.
- Mention missing artifact sections if they limit confidence.
- Do not invent screenshots, videos, logs, or memory context that was not returned by MCP.
- If MCP is unavailable, use dashboard REST APIs or `agent-qa` CLI output as fallback and say which evidence was unavailable.
