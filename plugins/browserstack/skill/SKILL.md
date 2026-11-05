---
name: agent-qa-plugin-browserstack
description: Run agent-qa web tests on BrowserStack browsers through the BrowserStack plugin.
---

# BrowserStack remotes for agent-qa

The BrowserStack plugin runs a web test on a BrowserStack browser over the Playwright protocol.

```yaml
plugins:
  - name: browserstack
    package: "@vostride/agent-qa-plugin-browserstack"
    options:
      username: "{{secret:BROWSERSTACK_USERNAME}}"
      accessKey: "{{secret:BROWSERSTACK_ACCESS_KEY}}"

registry:
  remotes:
    - name: browserstack
      plugin: browserstack
      settings: { os: Windows, osVersion: "11" }
```

- `options.username` and `options.accessKey` are BrowserStack credentials. Keep them in secrets.
- `settings` holds `os`, `osVersion`, `browser`, `browserVersion`, `project` and `build`. `extra`
  is merged last into the capabilities, for ones the settings do not cover.
- The session name is the test's name and the build is the run id unless `settings.build` is set.
- BrowserStack must list agent-qa's Playwright version, or a web test is refused with one line
  naming both versions.
