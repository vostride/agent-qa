import { CheckCircle2, XCircle } from "lucide-react"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import type { ReasoningTrace } from "@/lib/api"

interface HealingChainProps {
  attempts: ReasoningTrace["healAttempts"]
}

export function HealingChain({ attempts }: HealingChainProps) {
  if (!attempts || attempts.length === 0) return null

  return (
    <Accordion type="single" collapsible className="w-full">
      {attempts.map((attempt, i) => (
        <AccordionItem key={i} value={`attempt-${i}`}>
          <AccordionTrigger className="py-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">
                Attempt {attempt.attemptNumber ?? i + 1}
              </span>
              {attempt.strategy && (
                <Badge variant="secondary" className="text-xs">
                  {attempt.strategy}
                </Badge>
              )}
              {attempt.success ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-red-500" />
              )}
            </div>
          </AccordionTrigger>
          <AccordionContent className="space-y-2">
            {attempt.reasoning && (
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-0.5">
                  Reasoning
                </p>
                <p className="text-sm">{attempt.reasoning}</p>
              </div>
            )}
            {attempt.observationBefore && (
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-0.5">
                  Observation Before
                </p>
                <p className="text-sm text-muted-foreground">
                  {attempt.observationBefore.length > 200
                    ? `${attempt.observationBefore.slice(0, 200)}…`
                    : attempt.observationBefore}
                </p>
              </div>
            )}
            {attempt.observationAfter && (
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-0.5">
                  Observation After
                </p>
                <p className="text-sm text-muted-foreground">
                  {attempt.observationAfter.length > 200
                    ? `${attempt.observationAfter.slice(0, 200)}…`
                    : attempt.observationAfter}
                </p>
              </div>
            )}
            {attempt.action != null && (
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-0.5">
                  Action
                </p>
                <pre className="text-xs font-mono bg-muted/50 rounded p-2 overflow-x-auto">
                  {typeof attempt.action === "string"
                    ? attempt.action
                    : JSON.stringify(attempt.action, null, 2)}
                </pre>
              </div>
            )}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}
