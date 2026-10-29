import './color-posture.js'
import { nodeFloorRefusal } from './node-floor.js'

// a variable specifier keeps the bundler from inlining the CLI, so no
// static import evaluates (and reads the environment) before the posture above.
const main = './cli-main.js'

const refusal = nodeFloorRefusal(process.version)
if (refusal !== undefined) {
  process.stderr.write(refusal)
  process.exit(2)
} else {
  void import(main).catch((error: unknown) => {
    console.error(`Framework error: ${error instanceof Error ? error.message : String(error)}`)
    // the stack follows the line, so a load-time or synchronous
    // CLI failure still names where it threw.
    if (error instanceof Error && error.stack) console.error(error.stack)
    process.exit(2)
  })
}
