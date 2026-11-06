---
name: agent-qa-plugin-steel
description: Use when configuring agent-qa web tests to run in Steel cloud browsers through the Steel plugin, or when a Steel remote is refused.
---

# Steel remotes for agent-qa

The Steel plugin gives an agent-qa web test a Steel browser session. Before the test connects it
creates a session through Steel's API, and after the test it releases the session. Steel runs
Chromium only. CAPTCHA solving, ad blocking, proxies and fingerprint injection are off unless a
setting turns them on.
