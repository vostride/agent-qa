// Stands in for the BrowserStackLocal binary: `--daemon start` leaves a detached sleeper running
// and prints the JSON the real binary prints once its tunnel is connected.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [record, mode, ...args] = process.argv.slice(2)

if (mode === 'fail') {
  process.stderr.write('stub BrowserStackLocal: refusing to start\n')
  process.exit(1)
}

if (args[0] === '--daemon' && args[1] === 'start') {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  sleeper.unref()
  writeFileSync(record, JSON.stringify({ args, pid: sleeper.pid }))
  process.stdout.write(JSON.stringify({ state: 'connected', pid: sleeper.pid }))
  process.exit(0)
}

process.stdout.write(JSON.stringify({ state: 'disconnected', message: { message: 'unknown' } }))
