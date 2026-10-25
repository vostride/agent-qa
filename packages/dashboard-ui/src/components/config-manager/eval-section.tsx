// EVALUATION (429-28 · D-06, D-07 · UI-SPEC S7 "Evaluation", E9).
//
// Every eval leaf as one field in its group. Judges are picked from the registered models, at most
// three. The schema refuses a file declaring both eval.judge and eval.judges, so every pick writes
// the one key its count calls for and removes the other in the same write. Each pick is computed
// from the freshest config the page holds and first states what it read (429-46), so a list an
// outside edit changed is re-read and the pick lands on it.

import { useId, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router"
import type { ConfigChange } from "@vostride/agent-qa-schema"

import { ConfigField } from "@/components/config-manager/config-field"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { useConfigAutosaveContext } from "@/hooks/use-config-autosave"
import {
  EVAL_FIELD_HELP,
  EVAL_FIELD_LABELS,
  EVAL_GROUP_LABELS,
  JUDGE_LIMIT_TEXT,
  JUDGE_MODELS_LABEL,
  JUDGE_NO_MODELS_TEXT,
} from "@/lib/config-copy"
import { configTabPath } from "@/lib/config-tabs"

export interface EvalSectionProps {
  config: Record<string, unknown>
}

type EvalGroup = keyof typeof EVAL_GROUP_LABELS

const JUDGE_LIMIT = 3
const ADD_MODEL_HREF = `${configTabPath("models")}?add`
const POSITIVE_INTEGER = { min: 1, integer: true } as const

function evalField(...rest: string[]) {
  return { segments: ["eval", ...rest], tab: "advanced" as const, pattern: ["eval", ...rest].join(".") }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function registeredModelNames(config: Record<string, unknown>): string[] {
  const llms = isRecord(config.registry) ? config.registry.llms : undefined
  if (!Array.isArray(llms)) return []
  return llms.flatMap((entry) => (isRecord(entry) && typeof entry.name === "string" ? [entry.name] : []))
}

function configuredJudges(config: Record<string, unknown>): string[] {
  const block = isRecord(config.eval) ? config.eval : {}
  if (Array.isArray(block.judges)) return block.judges.filter((name): name is string => typeof name === "string")
  return typeof block.judge === "string" ? [block.judge] : []
}

/** The write for a judge list: sets come first, so the loaded config mirrors the whole change set. */
function judgeChanges(judges: readonly string[]): ConfigChange[] {
  const judge = ["eval", "judge"]
  const list = ["eval", "judges"]
  if (judges.length === 0) return [{ op: "unset", path: judge }, { op: "unset", path: list }]
  if (judges.length === 1) return [{ op: "set", path: judge, value: judges[0] }, { op: "unset", path: list }]
  return [{ op: "set", path: list, value: [...judges] }, { op: "unset", path: judge }]
}

/**
 * One judge toggle applied to the list the given config holds, led by the two expect ops that state
 * what was read; [] when the toggle already holds or a check would pass the limit.
 */
export function judgeToggleChanges(
  config: Record<string, unknown>,
  name: string,
  checked: boolean,
): ConfigChange[] {
  const block = isRecord(config.eval) ? config.eval : {}
  const current = configuredJudges(config)
  if (checked === current.includes(name) || (checked && current.length >= JUDGE_LIMIT)) return []
  const next = checked ? [...current, name] : current.filter((judge) => judge !== name)
  return [
    { op: "expect", path: ["eval", "judge"], value: block.judge ?? null },
    { op: "expect", path: ["eval", "judges"], value: block.judges ?? null },
    ...judgeChanges(next),
  ]
}

function Group({ id, children }: { id: EvalGroup; children: ReactNode }) {
  const headingId = `eval-group-${id}`
  return (
    <div data-eval-group={id} role="group" aria-labelledby={headingId} className="space-y-4">
      <h3 id={headingId} className="text-sm font-medium">
        {EVAL_GROUP_LABELS[id]}
      </h3>
      {children}
    </div>
  )
}

function JudgePicker({ config }: EvalSectionProps) {
  const autosave = useConfigAutosaveContext()
  const baseId = useId()
  const [pending, setPending] = useState<string[] | undefined>(undefined)
  const seq = useRef(0)

  const selected = pending ?? configuredJudges(config)
  const registered = registeredModelNames(config)
  // A judge the file names but no model declares still shows, so it can be unchecked.
  const names = [...registered, ...selected.filter((name) => !registered.includes(name))]
  const full = selected.length >= JUDGE_LIMIT

  async function toggle(name: string, checked: boolean) {
    const has = selected.includes(name)
    if (checked === has || (checked && full)) return
    const next = checked ? [...selected, name] : selected.filter((judge) => judge !== name)
    const id = ++seq.current
    setPending(next)
    await autosave.runComputed((latest) => judgeToggleChanges(latest, name, checked))
    if (id === seq.current) setPending(undefined)
  }

  return (
    <div data-judge-picker data-field-path="eval.judge" className="space-y-2">
      <div data-field-path="eval.judges" role="group" aria-labelledby={`${baseId}-label`} className="space-y-2">
        <p id={`${baseId}-label`} className="text-sm font-medium leading-none">
          {JUDGE_MODELS_LABEL}
        </p>
        {names.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            <Link to={ADD_MODEL_HREF} className="underline underline-offset-4 hover:text-foreground">
              {JUDGE_NO_MODELS_TEXT}
            </Link>
          </p>
        ) : (
          <div className="space-y-2">
            {names.map((name, index) => {
              const id = `${baseId}-judge-${index}`
              const checked = selected.includes(name)
              return (
                <div key={name} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    data-judge-name={name}
                    checked={checked}
                    disabled={!checked && full}
                    onCheckedChange={(next) => void toggle(name, next === true)}
                  />
                  <Label htmlFor={id} className="min-w-0 font-mono font-normal wrap-anywhere">
                    {name}
                  </Label>
                </div>
              )
            })}
          </div>
        )}
        {full ? <p className="text-xs text-muted-foreground">{JUDGE_LIMIT_TEXT}</p> : null}
      </div>
    </div>
  )
}

export function EvalSection({ config }: EvalSectionProps) {
  return (
    <>
      <Group id="judge">
        <JudgePicker config={config} />
        <ConfigField
          field={evalField("judgeAllowSameFamily")}
          label={EVAL_FIELD_LABELS.judgeAllowSameFamily}
          kind="switch"
          help={EVAL_FIELD_HELP.judgeAllowSameFamily}
        />
        <ConfigField field={evalField("k")} label={EVAL_FIELD_LABELS.k} kind="number" placeholder="3" number={POSITIVE_INTEGER} />
        <ConfigField field={evalField("seed")} label={EVAL_FIELD_LABELS.seed} kind="number" number={{ integer: true }} />
      </Group>
    </>
  )
}
