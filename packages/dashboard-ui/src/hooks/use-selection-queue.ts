import { useCallback, useEffect, useMemo, useState } from "react"

interface SelectionQueueState<T> {
  ids: string[]
  itemsById: Map<string, T>
}

function getToggleState(selectedCount: number, totalCount: number): boolean | "indeterminate" {
  if (selectedCount === 0) return false
  if (selectedCount === totalCount) return true
  return "indeterminate"
}

export function useSelectionQueue<T>({
  items,
  getId,
  visibleIds,
}: {
  items: readonly T[]
  getId: (item: T) => string
  visibleIds?: readonly string[]
}) {
  const [state, setState] = useState<SelectionQueueState<T>>({
    ids: [],
    itemsById: new Map(),
  })

  useEffect(() => {
    setState((current) => {
      let changed = false
      const nextItemsById = new Map(current.itemsById)

      for (const item of items) {
        const id = getId(item)
        if (!nextItemsById.has(id)) continue
        if (nextItemsById.get(id) !== item) {
          nextItemsById.set(id, item)
          changed = true
        }
      }

      return changed ? { ids: current.ids, itemsById: nextItemsById } : current
    })
  }, [getId, items])

  const selectedIds = state.ids
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const selectedItems = useMemo(
    () => selectedIds
      .map((id) => state.itemsById.get(id))
      .filter((item): item is T => item !== undefined),
    [selectedIds, state.itemsById],
  )

  const visibleIdList = useMemo(
    () => visibleIds ?? items.map((item) => getId(item)),
    [getId, items, visibleIds],
  )
  const visibleIdSet = useMemo(() => new Set(visibleIdList), [visibleIdList])
  const hiddenCount = useMemo(
    () => selectedIds.filter((id) => !visibleIdSet.has(id)).length,
    [selectedIds, visibleIdSet],
  )

  const isSelected = useCallback(
    (id: string) => selectedIdSet.has(id),
    [selectedIdSet],
  )

  const setItemSelected = useCallback(
    (item: T, selected: boolean) => {
      const id = getId(item)
      setState((current) => {
        const alreadySelected = current.ids.includes(id)
        if (selected && alreadySelected) {
          if (current.itemsById.get(id) === item) return current
          const nextItemsById = new Map(current.itemsById)
          nextItemsById.set(id, item)
          return { ids: current.ids, itemsById: nextItemsById }
        }
        if (!selected && !alreadySelected) return current

        const nextItemsById = new Map(current.itemsById)
        if (selected) {
          nextItemsById.set(id, item)
          return { ids: [...current.ids, id], itemsById: nextItemsById }
        }

        nextItemsById.delete(id)
        return {
          ids: current.ids.filter((candidate) => candidate !== id),
          itemsById: nextItemsById,
        }
      })
    },
    [getId],
  )

  const setItemsSelected = useCallback(
    (nextItems: readonly T[], selected: boolean) => {
      if (nextItems.length === 0) return
      setState((current) => {
        const nextItemsById = new Map(current.itemsById)
        const nextIds = [...current.ids]
        let changed = false

        for (const item of nextItems) {
          const id = getId(item)
          const alreadySelected = nextIds.includes(id)
          if (selected) {
            if (!alreadySelected) {
              nextIds.push(id)
              changed = true
            }
            if (nextItemsById.get(id) !== item) {
              nextItemsById.set(id, item)
              changed = true
            }
            continue
          }

          if (!alreadySelected) continue
          changed = true
          nextItemsById.delete(id)
          nextIds.splice(nextIds.indexOf(id), 1)
        }

        return changed ? { ids: nextIds, itemsById: nextItemsById } : current
      })
    },
    [getId],
  )

  const clearSelection = useCallback(() => {
    setState((current) => {
      if (current.ids.length === 0) return current
      return { ids: [], itemsById: new Map() }
    })
  }, [])

  const getVisibleSelectionState = useCallback(
    (ids: readonly string[]) => {
      const selectedCount = ids.filter((id) => selectedIdSet.has(id)).length
      return getToggleState(selectedCount, ids.length)
    },
    [selectedIdSet],
  )

  return {
    selectedIds,
    selectedIdSet,
    selectedItems,
    selectedCount: selectedIds.length,
    hiddenCount,
    isSelected,
    setItemSelected,
    setItemsSelected,
    clearSelection,
    getVisibleSelectionState,
  }
}
