import { Command } from 'commander'
import pc from 'picocolors'
import {
  ENTITY_ID_TYPES,
  generateCanonicalId,
  getEntityIdContract,
  isCanonicalId,
  type EntityIdType,
} from '@vostride/agent-qa-ids'

function parseEntityType(value: string): EntityIdType {
  if ((ENTITY_ID_TYPES as readonly string[]).includes(value)) {
    return value as EntityIdType
  }
  throw new Error(`Unknown ID type "${value}". Expected one of: ${ENTITY_ID_TYPES.join(', ')}`)
}

export function createIdsCommand(): Command {
  const cmd = new Command('ids')
    .description('Generate and validate canonical agent-qa entity IDs')

  cmd
    .command('generate')
    .description('Generate a canonical agent-qa ID using id-agent')
    .argument('<type>', `entity type: ${ENTITY_ID_TYPES.join('|')}`)
    .option('--json', 'print structured JSON')
    .action((typeValue: string, opts: { json?: boolean }) => {
      try {
        const type = parseEntityType(typeValue)
        const id = generateCanonicalId(type)
        const contract = getEntityIdContract(type)
        if (opts.json) {
          console.log(JSON.stringify({ id, type, contract }, null, 2))
        } else {
          console.log(id)
        }
      } catch (err) {
        console.error(pc.red(err instanceof Error ? err.message : String(err)))
        process.exitCode = 1
      }
    })

  cmd
    .command('validate')
    .description('Validate a canonical agent-qa ID')
    .argument('<type>', `entity type: ${ENTITY_ID_TYPES.join('|')}`)
    .argument('<id>', 'ID to validate')
    .option('--json', 'print structured JSON')
    .action((typeValue: string, id: string, opts: { json?: boolean }) => {
      try {
        const type = parseEntityType(typeValue)
        const contract = getEntityIdContract(type)
        const valid = isCanonicalId(type, id)
        const result = {
          valid,
          id,
          type,
          contract,
          message: valid
            ? 'ID is canonical.'
            : `Expected ${contract.prefixWithSeparator} followed by ${contract.words} id-agent words.`,
        }
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2))
        } else if (valid) {
          console.log(pc.green(result.message))
        } else {
          console.error(pc.red(result.message))
        }
        if (!valid) {
          process.exitCode = 1
        }
      } catch (err) {
        console.error(pc.red(err instanceof Error ? err.message : String(err)))
        process.exitCode = 1
      }
    })

  return cmd
}
