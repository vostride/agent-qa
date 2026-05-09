import { useState, useEffect, useRef } from "react"
import { toast } from "sonner"
import DOMPurify from "dompurify"
import { marked } from "marked"
import { BookOpenText, Pencil, Eye, FilePlus, FolderOpen, Loader2 } from "lucide-react"
import {
  ConfigSectionBody,
  ConfigSectionHeader,
  ConfigSectionShell,
} from "@/components/config-manager/config-section-shell"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { fetchAgentRules, updateAgentRules, createAgentRulesFile, updateSettings } from "@/lib/api"

interface AgentRulesSectionProps {
  config: Record<string, unknown>
  onConfigChange: () => void
}

export function AgentRulesSection({ config, onConfigChange }: AgentRulesSectionProps) {
  const [loading, setLoading] = useState(true)
  const [content, setContent] = useState("")
  const [filePath, setFilePath] = useState<string | null>(null)
  const [hasConfig, setHasConfig] = useState(false)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editingPath, setEditingPath] = useState(false)
  const [pathInput, setPathInput] = useState("")
  const savedContent = useRef("")

  const isDirty = content !== savedContent.current

  async function loadRules() {
    setLoading(true)
    try {
      const res = await fetchAgentRules()
      if (res.error === 'no_config') {
        setHasConfig(false)
        setFilePath(null)
        setContent("")
        savedContent.current = ""
      } else {
        setHasConfig(true)
        setFilePath(res.filePath)
        const text = res.content ?? ""
        setContent(text)
        savedContent.current = text
      }
    } catch {
      toast.error("Failed to load agent rules")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRules() }, [])

  async function handleSave() {
    setSaving(true)
    try {
      await updateAgentRules(content)
      savedContent.current = content
      onConfigChange()
      toast.success("Configuration saved")
    } catch {
      toast.error("Failed to save agent rules")
    } finally {
      setSaving(false)
    }
  }

  function handleReset() {
    setContent(savedContent.current)
  }

  async function handleCreate() {
    setCreating(true)
    try {
      const res = await createAgentRulesFile()
      setHasConfig(true)
      setFilePath(res.filePath)
      setContent("")
      savedContent.current = ""
      onConfigChange()
      toast.success("Agent rules file created")
    } catch {
      toast.error("Failed to create rules file")
    } finally {
      setCreating(false)
    }
  }

  async function handlePathChange(newPath: string) {
    setEditingPath(false)
    if (newPath === filePath) return
    try {
      await updateSettings({ 'workspace.agentRules': newPath })
      onConfigChange()
      await loadRules()
    } catch {
      toast.error("Failed to update file path")
    }
  }

  function handlePathKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      handlePathChange(pathInput)
    } else if (e.key === 'Escape') {
      setEditingPath(false)
    }
  }

  function renderPreview() {
    if (!content.trim()) {
      return (
        <div className="text-sm text-muted-foreground text-center py-12">
          Nothing to preview. Switch to the Edit tab to write your rules.
        </div>
      )
    }
    const unsafeHtml = marked.parse(content, { async: false }) as string
    const html = DOMPurify.sanitize(unsafeHtml, {
      USE_PROFILES: { html: true },
    })
    return (
      <div
        className="markdown-preview"
        role="document"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  if (loading) {
    return (
      <ConfigSectionShell>
        <ConfigSectionHeader>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <BookOpenText className="size-5" />
            Agent Rules
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Custom instructions appended to the AI agent's system prompt</p>
        </ConfigSectionHeader>
        <ConfigSectionBody>
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        </ConfigSectionBody>
      </ConfigSectionShell>
    )
  }

  if (!hasConfig) {
    return (
      <ConfigSectionShell>
        <ConfigSectionHeader>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <BookOpenText className="size-5" />
            Agent Rules
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Custom instructions appended to the AI agent's system prompt</p>
        </ConfigSectionHeader>
        <ConfigSectionBody>
          <div className="flex flex-col items-center justify-center py-12 text-center gap-4">
            <BookOpenText className="size-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-semibold">No agent rules file configured</p>
              <p className="text-xs text-muted-foreground mt-1">
                Create a markdown file with custom instructions for the AI agent. Rules are appended to the system prompt after the built-in rules.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : (
                <>
                  <FilePlus className="size-4 mr-1" />
                  Create Rules File
                </>
              )}
            </Button>
          </div>
        </ConfigSectionBody>
      </ConfigSectionShell>
    )
  }

  return (
    <ConfigSectionShell>
      <ConfigSectionHeader>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <BookOpenText className="size-5" />
          Agent Rules
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Custom instructions appended to the AI agent's system prompt</p>
      </ConfigSectionHeader>
      <ConfigSectionBody>
        {/* File path bar */}
        <div className="flex items-center gap-2">
          <FolderOpen className="size-4 text-muted-foreground shrink-0" />
          {editingPath ? (
            <Input
              className="font-mono text-sm"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={handlePathKeyDown}
              onBlur={() => handlePathChange(pathInput)}
              placeholder="./path-to-rules.md"
              aria-label="Agent rules file path"
              autoFocus
            />
          ) : (
            <>
              <span className="font-mono text-sm text-muted-foreground truncate">{filePath}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto shrink-0"
                onClick={() => {
                  setPathInput(filePath ?? "")
                  setEditingPath(true)
                }}
              >
                Change Path
              </Button>
            </>
          )}
        </div>

        {/* Tabbed editor */}
        <Tabs defaultValue="edit">
          <TabsList>
            <TabsTrigger value="edit" className="gap-1.5">
              <Pencil className="size-3.5" />
              Edit
            </TabsTrigger>
            <TabsTrigger value="preview" className="gap-1.5">
              <Eye className="size-3.5" />
              Preview
            </TabsTrigger>
          </TabsList>
          <TabsContent value="edit">
            <Textarea
              className="min-h-[300px] font-mono text-sm leading-relaxed resize-y w-full"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write your custom agent rules in markdown..."
              aria-label="Agent rules markdown editor"
            />
          </TabsContent>
          <TabsContent value="preview">
            <div className="min-h-[300px] p-4 border border-border rounded-none overflow-y-auto">
              {renderPreview()}
            </div>
          </TabsContent>
        </Tabs>

        {/* Action buttons */}
        <div className="flex gap-2">
          <Button size="sm" onClick={handleSave} disabled={saving || !isDirty}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save Changes"}
          </Button>
        <Button variant="outline" size="sm" onClick={handleReset} disabled={!isDirty}>
          Reset Changes
        </Button>
      </div>
      </ConfigSectionBody>
    </ConfigSectionShell>
  )
}
