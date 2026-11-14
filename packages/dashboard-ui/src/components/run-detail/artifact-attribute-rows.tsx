import { Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { t } from "@/lib/i18n"

function sortedAttributeEntries(attributes: Record<string, string>) {
  return Object.entries(attributes).sort(([left], [right]) => {
    const leftInternal = left.startsWith("agent-qa.")
    const rightInternal = right.startsWith("agent-qa.")
    if (leftInternal !== rightInternal) return leftInternal ? -1 : 1
    return left.localeCompare(right)
  })
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value)
}

export function ArtifactAttributeRows({ attributes }: { attributes: Record<string, string> }) {
  const entries = sortedAttributeEntries(attributes)

  if (entries.length === 0) {
    return (
      <div className="rounded-[2px] border border-border p-4">
        <h3 className="text-sm font-medium text-foreground">{t("No run attributes")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("This run did not record any attributes.")}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => copyText(JSON.stringify(Object.fromEntries(entries), null, 2))}
        >
          <Copy className="size-4" />
          Copy JSON
        </Button>
      </div>
      <div className="overflow-hidden rounded-[2px] border border-border">
        <table className="w-full table-fixed text-sm">
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key} className="border-b border-border/70 last:border-b-0">
                <th className="w-[240px] align-top px-3 py-2 text-left font-mono text-xs font-medium text-muted-foreground">
                  {key}
                </th>
                <td className="align-top px-3 py-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{value}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Copy ${key} value`}
                      title={t("Copy value")}
                      onClick={() => copyText(value)}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

