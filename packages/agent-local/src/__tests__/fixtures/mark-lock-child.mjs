import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const input = JSON.parse(process.argv[2])
const publishSignal = (path, value) => {
  // File existence is the parent's readiness signal, so publish only complete bytes.
  const pending = path + '.pending'
  fs.writeFileSync(pending, value)
  fs.renameSync(pending, path)
}
if (input.pauseRead) {
  const original = fs.readFileSync
  let paused = false
  fs.readFileSync = function(path, ...args) {
    const value = original.call(this, path, ...args)
    if (!paused && String(path) === input.lock + '/owner.json') {
      paused = true
      publishSignal(input.pauseRead, value)
      while (!fs.existsSync(input.resumeRead)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    return value
  }
  syncBuiltinESMExports()
}
const { acquireMarkLock } = await import('../../store/mark-lock.ts')
const release = await acquireMarkLock(input.lock, input.runId, () => new Error('busy'))
try {
  publishSignal(input.entered, fs.readFileSync(input.lock + '/owner.json'))
  if (input.release) while (!fs.existsSync(input.release)) await new Promise(resolve => setTimeout(resolve, 10))
} finally { release() }
