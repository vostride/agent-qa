import { useSearchParams } from "react-router"
import { useCallback, useMemo, useRef } from "react"
import type { SortingState, OnChangeFn } from "@tanstack/react-table"

export function useSuitesSearchParams() {
  const [searchParams, setSearchParams] = useSearchParams()

  const status = searchParams.get("status") ?? ""
  const platform = searchParams.get("platform") ?? ""
  const sort = searchParams.get("sort") ?? ""
  const order = (searchParams.get("order") ?? "desc") as "asc" | "desc"

  const setParam = useCallback(
    (key: string, value: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (!value) {
          next.delete(key)
        } else {
          next.set(key, value)
        }
        return next
      }, { replace: true })
    },
    [setSearchParams]
  )

  const sorting: SortingState = useMemo(
    () => sort ? [{ id: sort, desc: order === "desc" }] : [],
    [sort, order]
  )

  const sortingRef = useRef(sorting)
  sortingRef.current = sorting

  const onSortingChange: OnChangeFn<SortingState> = useCallback(
    (updater) => {
      const next = typeof updater === "function" ? updater(sortingRef.current) : updater
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev)
        if (next.length > 0) {
          params.set("sort", next[0].id)
          params.set("order", next[0].desc ? "desc" : "asc")
        } else {
          params.delete("sort")
          params.delete("order")
        }
        return params
      }, { replace: true })
    },
    [setSearchParams]
  )

  return {
    status,
    platform,
    sort,
    order,
    sorting,
    onSortingChange,
    setStatus: useCallback((v: string) => setParam("status", v), [setParam]),
    setPlatform: useCallback((v: string) => setParam("platform", v), [setParam]),
  }
}
