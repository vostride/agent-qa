---
name: agent-qa-plugin-kernel
description: Run agent-qa web tests on Kernel cloud browsers through the Kernel plugin.
---

# Kernel remotes for agent-qa

The Kernel plugin creates a Kernel browser before a test connects and deletes it after the test.

```yaml
plugins:
  - name: kernel
    package: "@vostride/agent-qa-plugin-kernel"
    options:
      apiKey: "{{secret:KERNEL_API_KEY}}"

registry:
  remotes:
    - name: kernel
      plugin: kernel
      settings: { headless: true, timeoutSeconds: 60 }
```

- `options.apiKey` is the Kernel API key. Keep it in a secret, never in the config.
- `settings` holds `headless`, `timeoutSeconds`, `stealth`, `region`, `proxy` and `viewport`.
  `extra` is merged last into Kernel's create request, for fields the settings do not cover.
- Kernel runs Chromium only.
