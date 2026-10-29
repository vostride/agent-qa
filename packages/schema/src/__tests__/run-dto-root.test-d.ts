import { expectTypeOf } from 'vitest'
import type { z } from 'zod'
import { asJobId, asPatchId, jobSchema, patchSchema } from '../index'
import type {
  ExecutionContext,
  FileChange,
  Hunk,
  Job,
  JobConclusionKind,
  JobId,
  JobKind,
  JobStatus,
  Patch,
  PatchId,
  PatchStatus,
  RunId,
  RunSession,
  RunStatus,
} from '../index'

expectTypeOf(asJobId).parameter(0).toEqualTypeOf<string>()
expectTypeOf(asJobId).returns.toEqualTypeOf<JobId>()
expectTypeOf(asPatchId).returns.toEqualTypeOf<PatchId>()

expectTypeOf<z.infer<typeof jobSchema>>().toEqualTypeOf<Job>()
expectTypeOf<z.infer<typeof patchSchema>>().toEqualTypeOf<Patch>()

expectTypeOf<RunSession['status']>().toEqualTypeOf<'running' | RunStatus>()
expectTypeOf<RunSession['executionContext']>().toEqualTypeOf<ExecutionContext>()
expectTypeOf<RunSession['id']>().toEqualTypeOf<RunId>()

expectTypeOf<Job['id']>().toEqualTypeOf<JobId>()
expectTypeOf<Job['kind']>().toEqualTypeOf<JobKind>()
expectTypeOf<Job['status']>().toEqualTypeOf<JobStatus>()
expectTypeOf<Job['conclusionKind']>().toEqualTypeOf<JobConclusionKind | undefined>()

expectTypeOf<Patch['id']>().toEqualTypeOf<PatchId>()
expectTypeOf<Patch['status']>().toEqualTypeOf<PatchStatus>()
expectTypeOf<Patch['changes']>().toEqualTypeOf<FileChange[]>()
expectTypeOf<FileChange['hunks']>().toEqualTypeOf<Hunk[]>()
