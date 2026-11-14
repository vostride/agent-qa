import { useState, useEffect, useRef, useCallback } from "react"
import { useNavigate } from "react-router"
import { Play, FileText, FolderOpen, BarChart3, SlidersHorizontal, Search, Webhook, LifeBuoy } from "lucide-react"
import {
  fetchHookCatalog,
  fetchRuns,
  fetchTestFiles,
  fetchSuiteFiles,
  type HookCatalogEntry,
  type RunRow,
  type TestFileInfo,
  type SuiteFileInfo,
} from "@/lib/api"
import { configCommandLabel, CONFIG_SECTION_LABELS } from "@/lib/config-copy"
import { CONFIG_SECTION_ALIASES, searchConfigSections } from "@/lib/config-tabs"
import { routes } from "@/lib/routes"
import { runStatusClass } from "@/lib/status"
import { useProductTour } from "@/components/product-tour"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { t } from "@/lib/i18n"

const pages = [
  { title: "Runs", url: routes.runs, icon: Play },
  { title: "Tests", url: routes.tests, icon: FileText },
  { title: "Hooks", url: routes.hooks, icon: Webhook },
  { title: "Suites", url: routes.suites, icon: FolderOpen },
  { title: "Insights", url: routes.insights, icon: BarChart3 },
  { title: "Config", url: routes.config, icon: SlidersHorizontal },
]

const createActions = [
  {
    title: "New Test",
    url: routes.testNew,
    icon: FileText,
    value: "create add new test tests yaml",
  },
  {
    title: "New Suite",
    url: routes.suiteNew,
    icon: FolderOpen,
    value: "create add new suite suites yaml",
  },
  {
    title: "Create Hook",
    url: routes.hookNew,
    icon: Webhook,
    value: "create add new hook hooks setup teardown inline",
  },
]

function runStatusTextClass(status: string) {
  switch (runStatusClass(status)) {
    case "pass":
      return "text-green-500"
    case "fail":
      return "text-red-500"
    default:
      return "text-muted-foreground"
  }
}

interface SearchResults {
  runs: RunRow[]
  tests: TestFileInfo[]
  hooks: HookCatalogEntry[]
  suites: SuiteFileInfo[]
}

function emptySearchResults(): SearchResults {
  return { runs: [], tests: [], hooks: [], suites: [] }
}

function buildCommandValue(...values: Array<string | string[] | null | undefined>): string {
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean)
    .join(" ")
}

function matchesCommandQuery(values: Array<string | null | undefined>, lowerQuery: string): boolean {
  return values.some((value) => value?.toLowerCase().includes(lowerQuery))
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<SearchResults>(() => emptySearchResults())
  const [isSearching, setIsSearching] = useState(false)
  const navigate = useNavigate()
  const { restartTour } = useProductTour()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRequestRef = useRef(0)
  const configResults = searchQuery.trim().length < 2 ? [] : searchConfigSections(searchQuery)

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  const doSearch = useCallback(async (query: string, requestId: number) => {
    if (query.length < 2) {
      if (requestId === searchRequestRef.current) {
        setSearchResults(emptySearchResults())
        setIsSearching(false)
      }
      return
    }
    if (requestId === searchRequestRef.current) setIsSearching(true)
    try {
      const [runsData, testsData, hooksData, suitesData] = await Promise.all([
        fetchRuns({ name: query, limit: 5 }),
        fetchTestFiles(),
        fetchHookCatalog(),
        fetchSuiteFiles(),
      ])
      const lowerQuery = query.toLowerCase()
      const filteredTests = testsData.files
        .filter((test) => matchesCommandQuery([
          test.name,
          test.path,
          test.testId,
          test.targetName,
          test.platform,
        ], lowerQuery))
        .slice(0, 5)
      const filteredHooks = hooksData.hooks
        .filter((hook) => matchesCommandQuery([hook.name, hook.file, hook.id], lowerQuery))
        .slice(0, 5)
      const filteredSuites = suitesData.files
        .filter((suite) => matchesCommandQuery([suite.name, suite.path, suite.suiteId], lowerQuery))
        .slice(0, 5)
      if (requestId !== searchRequestRef.current) return
      setSearchResults({
        runs: runsData.runs,
        tests: filteredTests,
        hooks: filteredHooks,
        suites: filteredSuites,
      })
    } catch {
      if (requestId === searchRequestRef.current) setSearchResults(emptySearchResults())
    } finally {
      if (requestId === searchRequestRef.current) setIsSearching(false)
    }
  }, [])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    const requestId = searchRequestRef.current + 1
    searchRequestRef.current = requestId
    if (searchQuery.length < 2) {
      setSearchResults(emptySearchResults())
      setIsSearching(false)
      return
    }
    timerRef.current = setTimeout(() => doSearch(searchQuery, requestId), 200)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [searchQuery, doSearch])

  const closeAndReset = useCallback(() => {
    searchRequestRef.current += 1
    if (timerRef.current) clearTimeout(timerRef.current)
    setOpen(false)
    setSearchQuery("")
    setSearchResults(emptySearchResults())
    setIsSearching(false)
  }, [])

  function handleSelect(url: string) {
    navigate(url)
    closeAndReset()
  }

  function handleTakeProductTour() {
    restartTour()
    closeAndReset()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t("Command Palette")}
      description={t("Search runs, tests, hooks, suites, and pages...")}
      className="top-[18vh] translate-y-0"
    >
      <CommandInput
        placeholder={t("Search runs, tests, hooks, suites, and pages...")}
        value={searchQuery}
        onValueChange={setSearchQuery}
      />
      <CommandList className="min-h-[320px]">
        <CommandEmpty>{t("No results found.")}</CommandEmpty>

        <CommandGroup heading={t("Pages")}>
          {pages.map((page) => (
            <CommandItem
              key={page.url}
              value={`page-${page.title}`}
              onSelect={() => handleSelect(page.url)}
            >
              <page.icon />
              <span>{t(page.title)}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading={t("Create")}>
          {createActions.map((action) => (
            <CommandItem
              key={action.url}
              value={action.value}
              onSelect={() => handleSelect(action.url)}
            >
              <action.icon />
              <span>{t(action.title)}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading={t("Help")}>
          <CommandItem
            value="help take product tour onboarding agent-qa"
            data-tour-id="tour-command-product-tour"
            onSelect={handleTakeProductTour}
          >
            <LifeBuoy />
            <span>{t("Take product tour")}</span>
          </CommandItem>
        </CommandGroup>

        {searchResults.runs.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("Runs")}>
              {searchResults.runs.map((run) => (
                <CommandItem
                  key={run.id}
                  value={`run-${run.id}-${run.name}`}
                  onSelect={() => handleSelect(routes.runDetail(run.id))}
                >
                  <Play />
                  <span className="truncate">{run.name}</span>
                  <span className={`ml-auto text-xs ${runStatusTextClass(run.status)}`}>
                    {run.status}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {searchResults.tests.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("Tests")}>
              {searchResults.tests.map((test) => (
                <CommandItem
                  key={test.path}
                  value={buildCommandValue("test", test.testId, test.name, test.path, test.targetName, test.platform)}
                  onSelect={() => handleSelect(routes.testView(test.testId ?? test.path))}
                >
                  <FileText />
                  <span className="min-w-0 flex-1 truncate" title={test.name || test.path}>
                    {test.name || test.path}
                  </span>
                  {test.path && test.path !== test.name ? (
                    <span className="ml-auto max-w-[50%] truncate text-xs text-muted-foreground" title={test.path}>
                      {test.path}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {searchResults.hooks.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("Hooks")}>
              {searchResults.hooks.map((hook) => (
                <CommandItem
                  key={hook.id}
                  value={buildCommandValue("hook", hook.id, hook.name, hook.file)}
                  onSelect={() => handleSelect(routes.hookView(hook.id))}
                >
                  <Webhook />
                  <span className="min-w-0 flex-1 truncate">{hook.name}</span>
                  <span className="ml-auto max-w-[50%] truncate text-xs text-muted-foreground" title={hook.file}>
                    {hook.file}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {searchResults.suites.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("Suites")}>
              {searchResults.suites.map((suite) =>
                suite.suiteId ? (
                  <CommandItem
                    key={suite.suiteId}
                    value={buildCommandValue("suite", suite.suiteId, suite.name, suite.path)}
                    onSelect={() => handleSelect(routes.suiteView(suite.suiteId!))}
                  >
                    <FolderOpen />
                    <span className="min-w-0 flex-1 truncate" title={suite.name || suite.path}>
                      {suite.name || suite.path}
                    </span>
                    {suite.path ? (
                      <span className="ml-auto max-w-[50%] truncate text-xs text-muted-foreground" title={suite.path}>
                        {suite.path}
                      </span>
                    ) : null}
                  </CommandItem>
                ) : null
              )}
            </CommandGroup>
          </>
        )}

        {configResults.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("Config")}>
              {configResults.map(({ tab, section }) => (
                <CommandItem
                  key={`${tab}-${section}`}
                  value={buildCommandValue(
                    "config",
                    configCommandLabel(tab, section),
                    CONFIG_SECTION_LABELS[section],
                    [...CONFIG_SECTION_ALIASES[section]],
                  )}
                  onSelect={() => handleSelect(routes.configTab(tab, section))}
                >
                  <SlidersHorizontal />
                  <span>{configCommandLabel(tab, section)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {isSearching && (
          <div className="py-4 text-center text-sm text-muted-foreground">
            <Search className="inline size-4 mr-1 animate-pulse" />
            Searching...
          </div>
        )}
      </CommandList>
    </CommandDialog>
  )
}
