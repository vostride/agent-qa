import './color-posture.js'
import { nodeFloorRefusal } from './node-floor.js'

// A variable specifier keeps the bundler from inlining the CLI, so nothing loads before posture.
const main = './cli-main.js'

const refusal = nodeFloorRefusal(process.version)
if (refusal !== undefined) {
  process.stderr.write(refusal)
  process.exit(2)
} else {
  void import(main).catch((error: unknown) => {
    console.error(`Framework error: ${error instanceof Error ? error.message : String(error)}`)
    // The stack follows the line, so a load-time or synchronous failure still names where it threw.
    if (error instanceof Error && error.stack) console.error(error.stack)
    process.exit(2)
  })
}
