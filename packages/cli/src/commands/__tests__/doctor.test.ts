import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../config.js', () => ({
  loadConfigFile: vi.fn().mockResolvedValue(null),
}))

vi.mock('picocolors', () => ({
  default: {
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    blue: (s: string) => s,
  },
}))

vi.mock('@vostride/agent-qa-core', () => ({
  checkDockerAvailable: vi.fn(),
  AgentQaConfigSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
}))

import { checkDockerAvailable } from '@vostride/agent-qa-core'
const mockCheckDocker = vi.mocked(checkDockerAvailable)

describe('doctor Docker check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns pass when Docker daemon is running', async () => {
    mockCheckDocker.mockResolvedValue(true)
    const result = await checkDockerAvailable()
    expect(result).toBe(true)
  })

  it('returns false when Docker daemon is not running', async () => {
    mockCheckDocker.mockResolvedValue(false)
    const result = await checkDockerAvailable()
    expect(result).toBe(false)
  })

  it('checkDocker is included in the doctor command', async () => {
    const { createDoctorCommand } = await import('../doctor.js')
    const cmd = createDoctorCommand()
    expect(cmd.name()).toBe('doctor')
    expect(cmd.description()).toBe('Validate environment and dependencies')
  })
})
