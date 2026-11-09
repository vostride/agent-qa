import type { DoctorCheck } from './doctor.js'
import type { ProjectHost } from './project-host.js'

export interface SetupChecksInput {
  configPath: string
  host: Partial<ProjectHost>
}

export function createSetupChecks(_input: SetupChecksInput): DoctorCheck[] {
  return []
}
