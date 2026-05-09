import type { ComponentType } from 'react'
import { IoLogoNodejs, IoLogoPython, IoTerminal } from 'react-icons/io5'

import { BunRuntimeIcon } from '@/components/icons/bun-runtime-icon'
import type { HookRuntime } from '@/lib/api'

export interface HookRuntimeMeta {
  label: string
  shortLabel: string
  icon: ComponentType<{ className?: string }>
  monacoLanguage: string
  extension: string
  template: string
}

export const HOOK_RUNTIME_OPTIONS: HookRuntime[] = ['node', 'bun', 'python', 'bash']

export const HOOK_RUNTIME_ICONS = {
  node: IoLogoNodejs,
  bun: BunRuntimeIcon,
  python: IoLogoPython,
  bash: IoTerminal,
} as const

export const HOOK_RUNTIME_META: Record<HookRuntime, HookRuntimeMeta> = {
  node: {
    label: 'Node.js',
    shortLabel: 'JS',
    icon: HOOK_RUNTIME_ICONS.node,
    monacoLanguage: 'javascript',
    extension: '.js',
    template: [
      "const fs = require('node:fs')",
      '',
      'const envLines = [',
      "  'HOOK_STATUS=ready',",
      "  'HOOK_RUNTIME=node',",
      "].join('\\n')",
      '',
      "fs.writeFileSync('/tmp/agent-qa.env', `${envLines}\\n`)",
      "console.log('Hook wrote HOOK_STATUS and HOOK_RUNTIME to /tmp/agent-qa.env')",
      "console.error('Sample stderr: replace with warnings or debug details when needed')",
      '',
    ].join('\n'),
  },
  bun: {
    label: 'Bun',
    shortLabel: 'BUN',
    icon: HOOK_RUNTIME_ICONS.bun,
    monacoLanguage: 'typescript',
    extension: '.ts',
    template: [
      'const envLines = [',
      "  'HOOK_STATUS=ready',",
      "  'HOOK_RUNTIME=bun',",
      "].join('\\n')",
      '',
      "await Bun.write('/tmp/agent-qa.env', `${envLines}\\n`)",
      "console.log('Hook wrote HOOK_STATUS and HOOK_RUNTIME to /tmp/agent-qa.env')",
      "console.error('Sample stderr: replace with warnings or debug details when needed')",
      '',
    ].join('\n'),
  },
  python: {
    label: 'Python',
    shortLabel: 'PY',
    icon: HOOK_RUNTIME_ICONS.python,
    monacoLanguage: 'python',
    extension: '.py',
    template: [
      'from pathlib import Path',
      'import sys',
      '',
      "env_lines = '\\n'.join([",
      "    'HOOK_STATUS=ready',",
      "    'HOOK_RUNTIME=python',",
      "]) + '\\n'",
      '',
      "Path('/tmp/agent-qa.env').write_text(env_lines, encoding='utf-8')",
      "print('Hook wrote HOOK_STATUS and HOOK_RUNTIME to /tmp/agent-qa.env')",
      "print('Sample stderr: replace with warnings or debug details when needed', file=sys.stderr)",
      '',
    ].join('\n'),
  },
  bash: {
    label: 'Bash',
    shortLabel: 'SH',
    icon: HOOK_RUNTIME_ICONS.bash,
    monacoLanguage: 'shell',
    extension: '.sh',
    template: [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      "cat > /tmp/agent-qa.env <<'EOF'",
      'HOOK_STATUS=ready',
      'HOOK_RUNTIME=bash',
      'EOF',
      '',
      "echo 'Hook wrote HOOK_STATUS and HOOK_RUNTIME to /tmp/agent-qa.env'",
      "echo 'Sample stderr: replace with warnings or debug details when needed' >&2",
      '',
    ].join('\n'),
  },
}

function slugifyName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'new-hook'
}

export function getHookRuntimeMeta(runtime: HookRuntime): HookRuntimeMeta {
  return HOOK_RUNTIME_META[runtime]
}

export function runtimeToLanguage(runtime: HookRuntime): string {
  return HOOK_RUNTIME_META[runtime].monacoLanguage
}

export function buildHookDraft(runtime: HookRuntime, name = ''): { file: string; source: string } {
  const meta = getHookRuntimeMeta(runtime)
  return {
    file: `./hooks/${slugifyName(name)}${meta.extension}`,
    source: meta.template,
  }
}
