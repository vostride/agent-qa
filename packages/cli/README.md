![agent-qa banner](https://raw.githubusercontent.com/vostride/agent-qa/main/docs/assets/readme-banner.png)

<!-- # agent-qa -->

Open-source Agentic QA Harness with Memory
Write tests in natural language. agent-qa runs them across web and mobile with execution memory, catching regressions before release.

[Docs](https://vostride.com/docs/agent-qa) | [Quickstart](https://vostride.com/docs/agent-qa/quickstart)

## Features

- **Write tests in natural language**: Define actions and assertions in human language while agents work from visible roles, labels, and screen state.
- **Self-healing test execution**: When any sub-action, such as click, fill, or select, fails, agent-qa re-observes the UI and tries a different path in the same run. Tests recover from UI drift and flaky interactions instead of failing on the first broken action.
- **Evolves with every run**: With every test run, agent-qa builds execution memory from product, suite, and test observations, then adds that context to future runs. agent-qa also curates memory from steps that were healed during execution, helping future runs avoid the same mistake.
- **Built for humans and machines**: A polished dashboard and CLI for developers, plus MCP and skills for coding agents.
- **Accelerate runs with smart Cache**: The action cache reuses validated plans across similar subsequent test runs, reducing planner work, token usage, and runtime overhead.
- **Run sandboxed hooks during tests**: Run Node, Bun, Python, or Bash hooks in isolated Docker containers to set up environments, call APIs, seed fixtures, tear down state, or pass structured outputs back into the active test run.
- **Review your QA like code**: Tests, configs, hooks, memory, and suite logic all live as version-controlled code, so every change can be diffed, reviewed, reused, and shared across teams.
- **Bring your own LLM**: Run tests with the model of your choice via OpenAI- and Anthropic-compatible endpoints, Gemini, local or open-source models, and subscriptions like Codex and Claude Code.

## Quickstart

Install the package:

```sh
npm install -D agent-qa
```

For Codex or Claude Code subscription auth, also install:

```sh
npm install -D @vostride/agent-qa-subscription-auth
```

Install Docker before using hooks. agent-qa runs hooks in a sandboxed runtime, and Docker is required for the Node, Bun, Python, and Bash hook containers.

Initialize agent-qa and install the runtime support you need:

```sh
npx agent-qa init
npx agent-qa install-browsers --chromium
# Mobile projects:
npx agent-qa install-mobile-drivers --all
```

Start the dashboard, complete auth, and run tests from the UI:

```sh
npx agent-qa dashboard --open
```

For the full setup flow, use the [quickstart](https://vostride.com/docs/agent-qa/quickstart).

## CLI

Run tests from the CLI:

```sh
npx agent-qa run tests/hacker-news-top-story.yaml
```

## Docs

- [Full docs](https://vostride.com/docs/agent-qa)
- [Quickstart](https://vostride.com/docs/agent-qa/quickstart)
- [CLI reference](https://vostride.com/docs/agent-qa/cli)
- [Dashboard](https://vostride.com/docs/agent-qa/dashboard)
- [Configuration](https://vostride.com/docs/agent-qa/configuration)
- [License](LICENSE.md)
- [Notice](NOTICE.md)
