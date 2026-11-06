// Stands in for the BrowserStackLocal binary: `--daemon start` leaves a detached sleeper running
// and prints the JSON the real binary prints once its tunnel is connected. In `slow` mode the
// launch never connects and waits to be killed. `--daemon stop` stops the recorded sleeper.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const [record, mode, ...args] = process.argv.slice(2)

if (mode === 'fail') {
  process.stderr.write('stub BrowserStackLocal: refusing to start\n')
  process.exit(1)
}

if (args[0] === '--daemon' && args[1] === 'stop') {
  writeFileSync(`${record}.stop`, JSON.stringify({ args }))
  try {
    process.kill(JSON.parse(readFileSync(record, 'utf8')).pid, 'SIGKILL')
  } catch {}
  process.exit(0)
}

if (args[0] === '--daemon' && args[1] === 'start') {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  })
  sleeper.unref()
  writeFileSync(record, JSON.stringify({ args, pid: sleeper.pid, launcher: process.pid }))
  if (mode === 'slow') {
    setInterval(() => {}, 1000)
  } else {
    process.stdout.write(JSON.stringify({ state: 'connected', pid: sleeper.pid }))
    process.exit(0)
  }
} else {
  process.stdout.write(JSON.stringify({ state: 'disconnected', message: { message: 'unknown' } }))
}
