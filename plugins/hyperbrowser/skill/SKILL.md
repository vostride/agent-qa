---
name: agent-qa-plugin-hyperbrowser
description: Use when configuring agent-qa web tests to run in Hyperbrowser cloud browsers through the Hyperbrowser plugin, or when a Hyperbrowser remote is refused.
---

# Hyperbrowser remotes for agent-qa

The Hyperbrowser plugin gives an agent-qa web test a Hyperbrowser browser session. Before the test
connects it creates a session through Hyperbrowser's API, and after the test it stops the session.
Hyperbrowser runs Chromium only. Stealth, proxies, CAPTCHA solving, ad, tracker and annoyance
blocking and cookie auto-accept are off unless a setting turns them on.
