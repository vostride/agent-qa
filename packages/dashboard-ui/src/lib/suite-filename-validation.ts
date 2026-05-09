import { getWorkspaceFilenameError } from './filename-validation'

export function getSuiteFilenameError(
  filename: string,
  suiteMatchPatterns: string[] | undefined,
): string | null {
  return getWorkspaceFilenameError(filename, suiteMatchPatterns, 'suiteMatch')
}
