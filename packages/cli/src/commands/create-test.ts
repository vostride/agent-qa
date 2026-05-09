import { Command } from 'commander'
import { generateTestId } from '@vostride/agent-qa-ids'
import { stringify } from 'yaml'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import pc from 'picocolors'

export function createCreateTestCommand(): Command {
  const cmd = new Command('create-test')
    .description('Scaffold a new test YAML file with auto-generated ID')
    .argument('<path>', 'output file path for the test YAML')
    .action(async (path: string) => {
      const resolved = resolve(path)

      if (existsSync(resolved)) {
        console.error(pc.red('Error: File already exists: ' + resolved))
        process.exitCode = 1
        return
      }

      const testId = generateTestId()

      const template = {
        name: 'New test',
        'test-id': testId,
        target: 'my-target',
        steps: ['Describe your first test step here'],
      }

      const yamlContent = stringify(template)

      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, yamlContent, 'utf-8')

      console.log(pc.green('Created ' + resolved))
      console.log(pc.dim('  test-id: ' + testId))
    })

  return cmd
}
