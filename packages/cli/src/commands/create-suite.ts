import { Command } from 'commander'
import { generateSuiteId } from '@vostride/agent-qa-ids'
import { stringify } from 'yaml'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import pc from 'picocolors'

export function createCreateSuiteCommand(): Command {
  const cmd = new Command('create-suite')
    .description('Scaffold a new suite YAML file with auto-generated ID')
    .argument('<path>', 'output file path for the suite YAML')
    .action(async (path: string) => {
      const resolved = resolve(path)

      if (existsSync(resolved)) {
        console.error(pc.red('Error: File already exists: ' + resolved))
        process.exitCode = 1
        return
      }

      const suiteId = generateSuiteId()

      const template = {
        name: 'New suite',
        'suite-id': suiteId,
        tests: [],
      }

      const yamlContent = stringify(template).replace(
        'tests: []',
        'tests: []\n  # - test: ./path/to/test.yaml\n  #   id: my-test-id',
      )

      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, yamlContent, 'utf-8')

      console.log(pc.green('Created ' + resolved))
      console.log(pc.dim('  suite-id: ' + suiteId))
    })

  return cmd
}
