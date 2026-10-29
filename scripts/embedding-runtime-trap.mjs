// Fails closed: refuses any embedding runtime load and records each event in the JSONL report.

import { appendFileSync, realpathSync } from 'node:fs'
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveForbiddenRuntime, WORKSPACE_ROOT } from './lint-discovery-imports.mjs'

export const TRAP_REPORT_ENV = 'AGENT_QA_431_TRAP_REPORT'
export const TRAP_SENTINEL = 'AGENT_QA_431_RUNTIME_LOAD_TRAPPED'
export const TRAP_URL = import.meta.url
export const MODEL_ASSET_EXTENSIONS = Object.freeze(['.i8bin', '.onnx', '.onnx_data'])
export const FLOOR_ASSET_DIR = join(WORKSPACE_ROOT, 'packages', 'knowledge-local', 'assets')

/** Mirrors knowledge-local's `resolveModelCacheDir`; a cell pins the two equal. */
export function modelCacheDirFor(env = process.env) {
  const override = env.AGENT_QA_MODEL_CACHE_DIR
  if (override) return override
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'agent-qa', 'models')
  return join(homedir(), '.cache', 'agent-qa', 'models')
}

function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function within(path, dir) {
  return path === dir || path.startsWith(`${dir}${sep}`)
}

function pathOf(target) {
  if (typeof target === 'string') return target
  if (target instanceof URL) return target.protocol === 'file:' ? fileURLToPath(target) : undefined
  if (Buffer.isBuffer(target)) return target.toString('utf8')
  return undefined
}

export function installRuntimeLoadTrap(reportPath) {
  if (globalThis[Symbol.for(TRAP_SENTINEL)] !== undefined) return globalThis[Symbol.for(TRAP_SENTINEL)]
  const report = (record) => appendFileSync(reportPath, `${JSON.stringify({ pid: process.pid, ...record })}\n`)
  const derived = deriveForbiddenRuntime(WORKSPACE_ROOT)
  const packages = derived.packages.map(entry => ({ name: entry.name, dir: canonical(entry.dir) }))
  const names = new Set(derived.names)
  const assetRoots = [canonical(FLOOR_ASSET_DIR), canonical(modelCacheDirFor())]
  const observed = new Set()

  const refuse = (record) => {
    report({ event: 'violation', ...record })
    process.stderr.write(`${TRAP_SENTINEL} ${record.kind} ${record.identity}\n`)
    const error = new Error(`${TRAP_SENTINEL}: ${record.kind} ${record.identity}`)
    error.code = TRAP_SENTINEL
    throw error
  }
  const packageFor = (path) => packages.find(entry => within(path, entry.dir))
  const assetCheck = (target, via) => {
    const raw = pathOf(target)
    if (raw === undefined) return
    const path = canonical(raw)
    if (assetRoots.some(root => within(path, root)) || MODEL_ASSET_EXTENSIONS.includes(extname(path))) {
      refuse({ kind: 'asset', identity: path, via })
    }
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const path = context.conditions?.includes('require') ? 'cjs' : 'esm'
      if (!observed.has(path)) {
        observed.add(path)
        report({ event: 'observed', path })
      }
      const bare = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      if (names.has(bare) && !specifier.startsWith('.')) {
        refuse({ kind: 'module', identity: bare, specifier, path, parent: context.parentURL })
      }
      const resolved = nextResolve(specifier, context)
      if (resolved.url.startsWith('file:')) {
        const owner = packageFor(fileURLToPath(resolved.url))
        if (owner !== undefined) {
          refuse({ kind: 'module', identity: owner.name, specifier, path, url: resolved.url, parent: context.parentURL })
        }
      }
      return resolved
    },
  })

  const dlopen = process.dlopen
  process.dlopen = function trappedDlopen(module, filename, ...rest) {
    const owner = packageFor(canonical(filename))
    if (owner !== undefined) refuse({ kind: 'native', identity: owner.name, url: filename })
    return dlopen.call(this, module, filename, ...rest)
  }

  const wrap = (target, name, via) => {
    const original = target[name]
    target[name] = function trappedReader(file, ...rest) {
      assetCheck(file, via)
      return original.call(this, file, ...rest)
    }
  }
  const require = createRequire(import.meta.url)
  const fs = require('node:fs')
  for (const name of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream']) wrap(fs, name, `fs.${name}`)
  for (const name of ['readFile', 'open']) wrap(fs.promises, name, `fs.promises.${name}`)
  syncBuiltinESMExports()
  require('node:os')
  const state = { reportPath, packages, assetRoots, observed }
  globalThis[Symbol.for(TRAP_SENTINEL)] = state
  report({
    event: 'installed', node: process.version, roots: derived.roots,
    forbidden: [...names].sort(), packageDirs: packages.length, assetRoots, argv: process.argv.slice(1),
  })
  return state
}

/** Parse a report and fail closed on anything short of a live, complete trap. */
export function readTrapReport(text) {
  const records = text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  const installed = records.filter(record => record.event === 'installed')
  const observed = new Set(records.filter(record => record.event === 'observed').map(record => record.path))
  const violations = records.filter(record => record.event === 'violation')
  const problems = []
  if (installed.length === 0) problems.push('the trap never reported installed')
  for (const path of ['esm', 'cjs']) if (!observed.has(path)) problems.push(`the ${path} loader path was never observed`)
  if (installed.some(record => !Array.isArray(record.forbidden) || record.forbidden.length === 0)) {
    problems.push('the trap installed with an empty forbidden set')
  }
  return { records, installed, observed: [...observed].sort(), violations, problems }
}

const reportPath = process.env[TRAP_REPORT_ENV]
if (reportPath !== undefined && reportPath !== '') {
  installRuntimeLoadTrap(reportPath)
  await import('node:path')
}
