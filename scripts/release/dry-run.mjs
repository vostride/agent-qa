import { join, relative } from 'node:path'
import { getPublicPackages } from './packages.mjs'
import { createDockerTags, validateDockerReleasePlan } from './docker.mjs'
import { createPublishCommands } from './publish.mjs'
import { redactSecret, renderPosthogProjectFile } from './posthog.mjs'
import { assertSharedPublicVersion, computeTargetVersion, rewriteInternalWorkspaceRanges } from './version.mjs'
import { buildReleaseGatePlan } from './verify.mjs'

const dryRunPosthogKey = 'POSTHOG_PROJECT_KEY_DRY_RUN_PLACEHOLDER'

function commandLine(command) {
  return [command.command, ...command.args].join(' ')
}

function dryRunStagedRecords(records, targetVersion) {
  return records.map(record => {
    const pkg = rewriteInternalWorkspaceRanges({ ...record.pkg, version: targetVersion }, targetVersion)
    pkg.version = targetVersion
    return {
      ...record,
      dir: join(record.rootDir ?? process.cwd(), '.release/staged-packages', record.packageDirName),
      pkg,
    }
  })
}

function previewPublishCommands(records, targetVersion, rootDir) {
  const commands = createPublishCommands({ stagedRecords: records, version: targetVersion })
  const packageByDir = new Map(records.map(record => [record.dir, record.pkg.name]))
  return commands.map(command => ({
    package: packageByDir.get(command.cwd),
    command: commandLine(command),
    cwd: relative(rootDir, command.cwd) || '.',
  }))
}

function redactedPosthogPreview(projectKey) {
  return renderPosthogProjectFile(projectKey).replaceAll(projectKey, redactSecret(projectKey))
}

export function buildReleaseDryRunPlan(options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const bump = options.bump
  const namespace = options.namespace ?? 'vostride'
  const publicPackages = getPublicPackages({ rootDir })
  const currentVersion = assertSharedPublicVersion(publicPackages)
  const targetVersion = computeTargetVersion(currentVersion, bump)
  const stagedRecords = dryRunStagedRecords(publicPackages.map(record => ({ ...record, rootDir })), targetVersion)
  const docker = validateDockerReleasePlan({
    rootDir,
    version: targetVersion,
    namespace,
    latest: options.latest,
  })
  const projectKey = options.projectKey ?? options.env?.POSTHOG_PROJECT_KEY ?? dryRunPosthogKey

  return {
    dryRun: true,
    mutatesExternalState: false,
    writesFiles: false,
    bump,
    currentVersion,
    targetVersion,
    releaseGatePlan: buildReleaseGatePlan(bump),
    localValidation: [
      'pnpm install --frozen-lockfile',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm run validate:skills',
      'pnpm run validate:publish',
      `pnpm exec node scripts/release/stage-packages.mjs --target-version ${targetVersion} --out .release/staged-packages`,
      `pnpm exec node scripts/release/verify.mjs --bump ${bump} --stage postbuild --target-version ${targetVersion} --staged-dir .release/staged-packages`,
    ],
    npm: {
      trustedPublishing: true,
      usesNpmToken: false,
      publishCommands: previewPublishCommands(stagedRecords, targetVersion, rootDir),
    },
    posthog: {
      requiredSecret: 'POSTHOG_PROJECT_KEY',
      generatedFile: 'packages/core/src/analytics/posthog-project.ts',
      preview: redactedPosthogPreview(projectKey),
      secretValueIncluded: false,
    },
    docker: {
      namespace: docker.namespace,
      version: docker.version,
      validationCommand: `pnpm exec node scripts/release/docker.mjs --check-local --version ${targetVersion} --namespace ${docker.namespace}`,
      images: docker.images.map(image => ({
        id: image.id,
        image: image.image,
        dockerfile: image.dockerfile,
        tags: createDockerTags(image.image, targetVersion, { latest: options.latest }),
      })),
    },
    subscriptionAuth: {
      package: '@vostride/agent-qa-subscription-auth',
      status: 'dispatched_from_main_release_workflow',
      note: `agent-qa/.github/workflows/release.yml dispatches the subscription-auth release workflow at ${targetVersion} after npm packages and before Docker.`,
    },
  }
}

export function parseDryRunArgs(argv = []) {
  const parsed = {
    json: false,
    latest: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      continue
    } else if (arg === '--bump') {
      parsed.bump = argv[index + 1]
      if (!parsed.bump) throw new Error('missing --bump value')
      index += 1
    } else if (arg === '--namespace') {
      parsed.namespace = argv[index + 1]
      if (!parsed.namespace) throw new Error('missing --namespace value')
      index += 1
    } else if (arg === '--json') {
      parsed.json = true
    } else if (arg === '--latest') {
      parsed.latest = true
    } else {
      throw new Error(`invalid args: ${argv.join(' ')}`)
    }
  }

  if (!parsed.bump) throw new Error('missing --bump')
  return parsed
}

function renderText(plan) {
  const lines = [
    'agent-qa release dry-run',
    '',
    `Bump: ${plan.bump}`,
    `Version: ${plan.currentVersion} -> ${plan.targetVersion}`,
    'Mutates external state: no',
    'Writes files: no',
    '',
    'Release gate:',
    ...plan.releaseGatePlan.map((step, index) => `  ${index + 1}. ${step}`),
    '',
    'Local validation:',
    ...plan.localValidation.map(command => `  - ${command}`),
    '',
    'npm publish command preview:',
    ...plan.npm.publishCommands.map(command => `  - ${command.package}: ${command.command} (${command.cwd})`),
    '',
    'PostHog:',
    `  - required secret: ${plan.posthog.requiredSecret}`,
    `  - generated file: ${plan.posthog.generatedFile}`,
    '',
    'Docker image tag preview:',
    ...plan.docker.images.flatMap(image => [
      `  - ${image.image} (${image.dockerfile})`,
      ...image.tags.map(tag => `    - ${tag}`),
    ]),
    '',
    'Subscription auth:',
    `  - ${plan.subscriptionAuth.package}: ${plan.subscriptionAuth.status}`,
    `  - ${plan.subscriptionAuth.note}`,
    '',
  ]
  return `${lines.join('\n')}\n`
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseDryRunArgs(argv)
  const plan = buildReleaseDryRunPlan({
    rootDir: options.rootDir,
    env: options.env,
    projectKey: options.projectKey,
    bump: parsed.bump,
    namespace: parsed.namespace,
    latest: parsed.latest,
  })
  const output = options.output ?? process.stdout
  output.write?.(parsed.json ? `${JSON.stringify(plan, null, 2)}\n` : renderText(plan))
  return plan
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
