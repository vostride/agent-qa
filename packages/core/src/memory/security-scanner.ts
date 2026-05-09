const THREAT_PATTERNS: ReadonlyArray<{ id: string; regex: RegExp }> = [
  { id: 'prompt_injection', regex: /ignore\s+(previous|all|above|prior)\s+instructions/i },
  { id: 'role_hijack', regex: /you\s+are\s+now\s+/i },
  { id: 'deception', regex: /do\s+not\s+tell\s+the\s+user/i },
  { id: 'sys_override', regex: /system\s+prompt\s+override/i },
  { id: 'rule_bypass', regex: /disregard\s+(your|all|any)\s+(instructions|rules)/i },
  { id: 'restriction_bypass', regex: /act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits)/i },
  { id: 'exfil_curl', regex: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)/i },
  { id: 'exfil_wget', regex: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD)/i },
  { id: 'read_secrets', regex: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i },
  { id: 'ssh_backdoor', regex: /authorized_keys/i },
  { id: 'ssh_access', regex: /\$HOME\/\.ssh|~\/\.ssh/i },
]

const INVISIBLE_CHARS = new Set([
  0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF,
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
])

export function scanContent(text: string): { safe: boolean; matchedPattern?: string } {
  for (const { id, regex } of THREAT_PATTERNS) {
    if (regex.test(text)) return { safe: false, matchedPattern: id }
  }
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (INVISIBLE_CHARS.has(cp)) {
      return { safe: false, matchedPattern: `invisible_unicode_U+${cp.toString(16).toUpperCase().padStart(4, '0')}` }
    }
  }
  return { safe: true }
}

export function scanObservationText(title: string, content: string): { safe: boolean; matchedPattern?: string } {
  return scanContent([title, content].filter(Boolean).join('\n'))
}
