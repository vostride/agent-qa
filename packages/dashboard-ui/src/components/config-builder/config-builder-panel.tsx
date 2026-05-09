import { AlertCircle } from "lucide-react"
import { Separator } from "@/components/ui/separator"
import { useYamlDocument } from "@/hooks/use-yaml-document"
import { PlatformSection } from "./platform-section"
import { BrowserSection } from "./browser-section"
import { TimeoutSection } from "./timeout-section"
import { MatrixSection } from "./matrix-section"

interface ConfigBuilderPanelProps {
  content: string
  onChange: (yaml: string) => void
}

export function ConfigBuilderPanel({
  content,
  onChange,
}: ConfigBuilderPanelProps) {
  const { error, getIn, setIn, deleteIn } = useYamlDocument(content)

  function handleChange(path: string[], value: unknown) {
    onChange(setIn(path, value))
  }

  function handleDelete(path: string[]) {
    onChange(deleteIn(path))
  }

  const platform = getIn(["config", "platform"]) as string | undefined

  return (
    <div className="overflow-y-auto h-full p-4 space-y-6">
      <span className="text-sm font-medium text-muted-foreground">Config</span>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          <span>YAML syntax error: {error}</span>
        </div>
      )}

      <fieldset
        disabled={!!error}
        className={error ? "opacity-50 pointer-events-none" : ""}
      >
        <div className="space-y-6">
          <PlatformSection
            getIn={getIn}
            onChange={handleChange}
            onDelete={handleDelete}
            disabled={!!error}
          />

          <Separator />

          {platform === "web" && (
            <>
              <BrowserSection
                getIn={getIn}
                onChange={handleChange}
                onDelete={handleDelete}
                disabled={!!error}
              />
              <Separator />
            </>
          )}

          <TimeoutSection
            getIn={getIn}
            onChange={handleChange}
            onDelete={handleDelete}
            disabled={!!error}
          />

          <Separator />

          <MatrixSection
            getIn={getIn}
            onChange={handleChange}
            onDelete={handleDelete}
            disabled={!!error}
          />
        </div>
      </fieldset>
    </div>
  )
}
