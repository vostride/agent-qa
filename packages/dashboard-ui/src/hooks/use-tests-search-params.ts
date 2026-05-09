import { useCallback, useEffect, useMemo, useRef } from "react"
import { useSearchParams } from "react-router"
import type { OnChangeFn, PaginationState, SortingState } from "@tanstack/react-table"

const VALID_ORDERS = new Set(["asc", "desc"])
const TESTS_TABLE_PAGE_SIZE = 50

function normalizePage(value: string | null): number {
  if (!value) return 1
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 1 ? parsed : 1
}

function buildCanonicalParams(state: {
  search: string
  status: string
  platform: string
  target: string
  sort: string
  order: "asc" | "desc"
  page: number
}) {
  const next = new URLSearchParams()

  if (state.search) next.set("search", state.search)
  if (state.status) next.set("status", state.status)
  if (state.platform) next.set("platform", state.platform)
  if (state.target) next.set("target", state.target)
  if (state.sort) {
    next.set("sort", state.sort)
    next.set("order", state.order)
  }
  if (state.page > 1) next.set("page", String(state.page))

  return next
}

export function useTestsSearchParams() {
  const [searchParams, setSearchParams] = useSearchParams()

  const search = searchParams.get("search") ?? ""
  const status = searchParams.get("status") ?? ""
  const platform = searchParams.get("platform") ?? ""
  const target = searchParams.get("target") ?? ""
  const sort = searchParams.get("sort") ?? ""
  const orderParam = searchParams.get("order") ?? "desc"
  const order = (VALID_ORDERS.has(orderParam) ? orderParam : "desc") as "asc" | "desc"
  const page = normalizePage(searchParams.get("page"))

  const sorting: SortingState = useMemo(
    () => (sort ? [{ id: sort, desc: order === "desc" }] : []),
    [sort, order],
  )

  const sortingRef = useRef(sorting)
  sortingRef.current = sorting

  const state = useMemo(
    () => ({
      search,
      status,
      platform,
      target,
      sort,
      order,
      page,
    }),
    [search, status, platform, target, sort, order, page],
  )

  useEffect(() => {
    const canonical = buildCanonicalParams(state)
    const current = searchParams.toString()
    const next = canonical.toString()
    if (current !== next) {
      setSearchParams(canonical, { replace: true })
    }
  }, [searchParams, setSearchParams, state])

  const patchParams = useCallback(
    (
      patch: Partial<{
        search: string
        status: string
        platform: string
        target: string
        sort: string
        order: "asc" | "desc"
        page: number
      }>,
      options?: { resetPage?: boolean },
    ) => {
      const nextState = {
        ...state,
        ...patch,
      }
      if (options?.resetPage) nextState.page = 1
      setSearchParams(buildCanonicalParams(nextState), { replace: true })
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
        patchParams({ sort: "", order: "desc" })
      }
    },
    [patchParams],
  )

  const pagination: PaginationState = useMemo(
    () => ({ pageIndex: page - 1, pageSize: TESTS_TABLE_PAGE_SIZE }),
    [page],
  )

  const onPaginationChange: OnChangeFn<PaginationState> = useCallback(
    (updater) => {
      const next = typeof updater === "function" ? updater(pagination) : updater
      patchParams({ page: next.pageIndex + 1 })
    },
    [pagination, patchParams],
  )

  return {
    search,
    status,
    platform,
    target,
    sort,
    order,
    page,
    sorting,
    pagination,
    onSortingChange,
    onPaginationChange,
    setSearch: useCallback((value: string) => patchParams({ search: value }, { resetPage: true }), [patchParams]),
    setStatus: useCallback((value: string) => patchParams({ status: value }, { resetPage: true }), [patchParams]),
    setPlatform: useCallback((value: string) => patchParams({ platform: value }, { resetPage: true }), [patchParams]),
    setTarget: useCallback((value: string) => patchParams({ target: value }, { resetPage: true }), [patchParams]),
    setPage: useCallback((value: number) => patchParams({ page: value }), [patchParams]),
  }
}
