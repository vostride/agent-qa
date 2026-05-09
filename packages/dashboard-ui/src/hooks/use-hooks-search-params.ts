import { useCallback, useEffect, useMemo, useRef } from "react"
import { useSearchParams } from "react-router"
import type { OnChangeFn, SortingState } from "@tanstack/react-table"

const VALID_ORDERS = new Set(["asc", "desc"])

function buildCanonicalParams(state: {
  search: string
  runtime: string
  health: string
  sort: string
  order: "asc" | "desc"
}) {
  const next = new URLSearchParams()

  if (state.search) next.set("search", state.search)
  if (state.runtime) next.set("runtime", state.runtime)
  if (state.health) next.set("health", state.health)
  if (state.sort) {
    next.set("sort", state.sort)
    next.set("order", state.order)
  }

  return next
}

export function useHooksSearchParams() {
  const [searchParams, setSearchParams] = useSearchParams()

  const search = searchParams.get("search") ?? ""
  const runtime = searchParams.get("runtime") ?? ""
  const health = searchParams.get("health") ?? ""
  const sort = searchParams.get("sort") ?? ""
  const orderParam = searchParams.get("order") ?? "asc"
  const order = (VALID_ORDERS.has(orderParam) ? orderParam : "asc") as "asc" | "desc"

  const sorting: SortingState = useMemo(
    () => (sort ? [{ id: sort, desc: order === "desc" }] : []),
    [sort, order],
  )

  const sortingRef = useRef(sorting)
  sortingRef.current = sorting

  const state = useMemo(
    () => ({
      search,
      runtime,
      health,
      sort,
      order,
    }),
    [search, runtime, health, sort, order],
  )

  useEffect(() => {
    const canonical = buildCanonicalParams(state)
    if (canonical.toString() !== searchParams.toString()) {
      setSearchParams(canonical, { replace: true })
    }
  }, [searchParams, setSearchParams, state])

  const patchParams = useCallback(
    (
      patch: Partial<{
        search: string
        runtime: string
        health: string
        sort: string
        order: "asc" | "desc"
      }>,
    ) => {
      setSearchParams(buildCanonicalParams({ ...state, ...patch }), { replace: true })
    },
    [setSearchParams, state],
  )

  const onSortingChange: OnChangeFn<SortingState> = useCallback(
    (updater) => {
      const next = typeof updater === "function" ? updater(sortingRef.current) : updater
      if (next.length > 0) {
        patchParams({
          sort: next[0].id,
          order: next[0].desc ? "desc" : "asc",
        })
      } else {
        patchParams({ sort: "", order: "asc" })
      }
    },
    [patchParams],
  )

  return {
    search,
    runtime,
    health,
    sort,
    order,
    sorting,
    onSortingChange,
    setSearch: useCallback((value: string) => patchParams({ search: value }), [patchParams]),
    setRuntime: useCallback((value: string) => patchParams({ runtime: value }), [patchParams]),
    setHealth: useCallback((value: string) => patchParams({ health: value }), [patchParams]),
  }
}
