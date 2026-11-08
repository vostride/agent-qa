// Mirrors safety-local's CI marker set inline, so the CLI takes no dependency just to read env.
export const CI_VENDOR_VARS = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'TRAVIS', 'APPVEYOR', 'BUILDKITE',
  'DRONE', 'JENKINS_URL', 'HUDSON_URL', 'BITBUCKET_BUILD_NUMBER', 'TEAMCITY_VERSION',
] as const

export function resolveIsCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_VENDOR_VARS.some((name) => {
    const value = env[name]
    return value !== undefined && value !== '' && value.toLowerCase() !== 'false' && value !== '0'
  })
}
