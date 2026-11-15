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
import { useTranslation } from "@/i18n"
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

const pages = [
  { titleKey: "nav.runs", url: routes.runs, icon: Play },
  { titleKey: "nav.tests", url: routes.tests, icon: FileText },
  { titleKey: "nav.hooks", url: routes.hooks, icon: Webhook },
  { titleKey: "nav.suites", url: routes.suites, icon: FolderOpen },
  { titleKey: "nav.insights", url: routes.insights, icon: BarChart3 },
  { titleKey: "nav.config", url: routes.config, icon: SlidersHorizontal },
] as const

const createActions = [
  {
    titleKey: "nav.palette.newTest",
    searchKey: "nav.palette.newTestSearch",
    url: routes.testNew,
    icon: FileText,
  },
  {
    titleKey: "nav.palette.newSuite",
    searchKey: "nav.palette.newSuiteSearch",
    url: routes.suiteNew,
    icon: FolderOpen,
  },
  {
    titleKey: "nav.palette.createHook",
    searchKey: "nav.palette.createHookSearch",
    url: routes.hookNew,
    icon: Webhook,
  },
] as const

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
  const { t } = useTranslation()
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
      title={t("common.dialog.commandTitle")}
      description={t("nav.palette.description")}
      className="top-[18vh] translate-y-0"
    >
      <CommandInput
        placeholder={t("nav.palette.placeholder")}
        value={searchQuery}
        onValueChange={setSearchQuery}
      />
      <CommandList className="min-h-[320px]">
        <CommandEmpty>{t("nav.palette.empty")}</CommandEmpty>

        <CommandGroup heading={t("nav.palette.group.pages")}>
          {pages.map((page) => (
            <CommandItem
              key={page.url}
              value={`${t("nav.palette.kind.page")}-${t(page.titleKey)}`}
              onSelect={() => handleSelect(page.url)}
            >
              <page.icon />
              <span>{t(page.titleKey)}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading={t("nav.palette.group.create")}>
          {createActions.map((action) => (
            <CommandItem
              key={action.url}
              value={t(action.searchKey)}
              onSelect={() => handleSelect(action.url)}
            >
              <action.icon />
              <span>{t(action.titleKey)}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading={t("nav.palette.group.help")}>
          <CommandItem
            value={t("nav.palette.productTourSearch")}
            data-tour-id="tour-command-product-tour"
            onSelect={handleTakeProductTour}
          >
            <LifeBuoy />
            <span>{t("nav.takeProductTour")}</span>
          </CommandItem>
        </CommandGroup>

        {searchResults.runs.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("nav.palette.group.runs")}>
              {searchResults.runs.map((run) => (
                <CommandItem
                  key={run.id}
                  value={`${t("nav.palette.kind.run")}-${run.id}-${run.name}`}
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
            <CommandGroup heading={t("nav.palette.group.tests")}>
              {searchResults.tests.map((test) => (
                <CommandItem
                  key={test.path}
                  value={buildCommandValue(
                    t("nav.palette.kind.test"),
                    test.testId,
                    test.name,
                    test.path,
                    test.targetName,
                    test.platform,
                  )}
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
            <CommandGroup heading={t("nav.palette.group.hooks")}>
              {searchResults.hooks.map((hook) => (
                <CommandItem
                  key={hook.id}
                  value={buildCommandValue(
                    t("nav.palette.kind.hook"),
                    hook.id,
                    hook.name,
                    hook.file,
                  )}
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
            <CommandGroup heading={t("nav.palette.group.suites")}>
              {searchResults.suites.map((suite) =>
                suite.suiteId ? (
                  <CommandItem
                    key={suite.suiteId}
                    value={buildCommandValue(
                      t("nav.palette.kind.suite"),
                      suite.suiteId,
                      suite.name,
                      suite.path,
                    )}
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
            <CommandGroup heading={t("nav.palette.group.config")}>
              {configResults.map(({ tab, section }) => (
                <CommandItem
                  key={`${tab}-${section}`}
                  value={buildCommandValue(
                    t("nav.palette.kind.config"),
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
            {t("nav.palette.searching")}
          </div>
        )}
      </CommandList>
    </CommandDialog>
  )
}
