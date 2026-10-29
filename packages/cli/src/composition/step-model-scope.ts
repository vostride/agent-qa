import type { RunStepModelPorts } from '../commands/run.js'

type ScopeInput = Parameters<RunStepModelPorts['createScope']>[0]
type ModelInput = Parameters<RunStepModelPorts['createModel']>
type Consumers = ScopeInput['createConsumers']

export interface CliStepModelScopeOptions {
  ports: RunStepModelPorts
  planner: { profile: ModelInput[0]; auth: ModelInput[1]; model: ScopeInput['models']['planner']['model'] }
  verifier: { profile: ModelInput[0]; auth: ModelInput[1]; model: ScopeInput['models']['verifier']['model'] }
  mask: ScopeInput['mask']
  // Every step's consumers carry a verifier, so no scoped step trusts the planner.
  createConsumers: (...models: Parameters<Consumers>) => ReturnType<Consumers> & {
    verifier: NonNullable<ReturnType<Consumers>['verifier']>
  }
}

/**
 * The host retains its resolved metadata handles and accounting objects. Each
 * invocation binds a new raw observer through the central model constructor;
 * wrapping the already wrapped metadata handle would install safety twice.
 * The typed ports arrive from run.ts, the CLI's existing model/runner boundary.
 */
export function createCliStepModelScopeFactory(options: CliStepModelScopeOptions) {
  return (key: ScopeInput['key']) => options.ports.createScope({
    key,
    models: {
      planner: {
        model: options.planner.model,
        bind: observation => options.ports.createModel(options.planner.profile, options.planner.auth, options.mask, {}, observation),
      },
      verifier: {
        model: options.verifier.model,
        bind: observation => options.ports.createModel(options.verifier.profile, options.verifier.auth, options.mask, {}, observation),
      },
    },
    profiles: {
      planner: { provider: options.planner.profile.provider, modelId: options.planner.profile.model },
      verifier: { provider: options.verifier.profile.provider, modelId: options.verifier.profile.model },
    },
    mask: options.mask,
    createConsumers: options.createConsumers,
  })
}
