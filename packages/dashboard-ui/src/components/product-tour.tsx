import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useNavigate } from 'react-router'
import { FaGithub } from 'react-icons/fa'

import { Button } from '@/components/ui/button'
import { fetchTestFiles } from '@/lib/api'
import {
  PRODUCT_TOUR_AUTO_START_PATHS,
  getFirstProductTourStep,
  getProductTourStep,
  getProductTourStepIndex,
  getVisibleProductTourSteps,
  resolveProductTourStepRoute,
  type ProductTourRuntimeContext,
  type ProductTourStep,
} from '@/lib/product-tour-steps'
import {
  PRODUCT_TOUR_SCHEMA_VERSION,
  PRODUCT_TOUR_VERSION,
  clearProductTourStateCookie,
  readProductTourStateCookie,
  writeProductTourStateCookie,
  type ProductTourState,
} from '@/lib/product-tour-state'
import { cn } from '@/lib/utils'

interface ProductTourContextValue {
  isActive: boolean
  activeStepId: string | null
  activeStep: ProductTourStep | null
  visibleSteps: ProductTourStep[]
  pathname: string
  startTour: () => void
  restartTour: () => void
  skipTour: () => void
  completeTour: () => void
  nextStep: () => void
  backStep: () => void
  advanceAfterRunStarted: (runId: string | null | undefined, status?: string | null) => void
  recordRunDetailStatus: (status: string | null | undefined) => void
}

interface ProductTourProviderProps {
  children: ReactNode
  pathname: string
  hideHeader: boolean
}

interface AnchorPlacement {
  top: number
  left: number
  width: number
  height: number
}

const ProductTourContext = createContext<ProductTourContextValue | null>(null)

export function ProductTourProvider({ children, pathname, hideHeader }: ProductTourProviderProps) {
  const navigate = useNavigate()
  const [activeStepId, setActiveStepId] = useState<string | null>(null)
  const [autoStartChecked, setAutoStartChecked] = useState(false)
  const [runtimeContext, setRuntimeContext] = useState<ProductTourRuntimeContext>({})

  const visibleSteps = useMemo(() => getVisibleProductTourSteps(runtimeContext), [runtimeContext])
  const activeStep = activeStepId ? getProductTourStep(activeStepId, runtimeContext) : null

  const persistActiveStep = useCallback(
    (
      step: ProductTourStep,
      startedAt?: string,
      contextOverride: ProductTourRuntimeContext = runtimeContext,
    ) => {
      const route = resolveProductTourStepRoute(step, contextOverride)
      const currentState = readProductTourStateCookie()
      const state: ProductTourState = {
        schemaVersion: PRODUCT_TOUR_SCHEMA_VERSION,
        tourVersion: PRODUCT_TOUR_VERSION,
        lastStartedAt: startedAt ?? currentState?.lastStartedAt ?? new Date().toISOString(),
        activeStepId: step.id,
        ...(route && shouldPersistProductTourRoute(step) ? { activeRoute: route } : {}),
      }

      writeProductTourStateCookie(state)
      setActiveStepId(step.id)

      if (route && route !== pathname) {
        navigate(route)
      }
    },
    [navigate, pathname, runtimeContext],
  )

  const startTour = useCallback(() => {
    const firstStep = getFirstProductTourStep(runtimeContext)
    persistActiveStep(firstStep, new Date().toISOString())
    setAutoStartChecked(true)
  }, [persistActiveStep, runtimeContext])

  const restartTour = useCallback(() => {
    clearProductTourStateCookie()
    const nextContext = { ...runtimeContext, githubNudgeDismissed: false }
    setRuntimeContext(nextContext)
    const firstStep = getFirstProductTourStep(nextContext)
    persistActiveStep(firstStep, new Date().toISOString())
    setAutoStartChecked(true)
  }, [persistActiveStep, runtimeContext])

  const skipTour = useCallback(() => {
    writeProductTourStateCookie({
      schemaVersion: PRODUCT_TOUR_SCHEMA_VERSION,
      tourVersion: PRODUCT_TOUR_VERSION,
      skippedAt: new Date().toISOString(),
    })
    setRuntimeContext((current) => ({ ...current, githubNudgeDismissed: true }))
    setActiveStepId(null)
    setAutoStartChecked(true)
  }, [])

  const completeTour = useCallback(() => {
    writeProductTourStateCookie({
      schemaVersion: PRODUCT_TOUR_SCHEMA_VERSION,
      tourVersion: PRODUCT_TOUR_VERSION,
      completedAt: new Date().toISOString(),
    })
    setRuntimeContext((current) => ({ ...current, githubNudgeDismissed: true }))
    setActiveStepId(null)
    setAutoStartChecked(true)
  }, [])

  const activateByOffset = useCallback(
    (offset: number) => {
      if (!activeStepId) {
        startTour()
        return
      }

      const currentIndex = getProductTourStepIndex(activeStepId, runtimeContext)
      if (currentIndex < 0) {
        startTour()
        return
      }

      const nextIndex = currentIndex + offset
      if (nextIndex >= visibleSteps.length) {
        completeTour()
        return
      }
      if (nextIndex < 0) return

      persistActiveStep(visibleSteps[nextIndex])
    },
    [activeStepId, completeTour, persistActiveStep, runtimeContext, startTour, visibleSteps],
  )

  const nextStep = useCallback(() => activateByOffset(1), [activateByOffset])
  const backStep = useCallback(() => activateByOffset(-1), [activateByOffset])

  const advanceAfterRunStarted = useCallback(
    (runId: string | null | undefined, status?: string | null) => {
      const nextContext: ProductTourRuntimeContext = {
        ...runtimeContext,
        runId: runId || null,
        runStatus: status ?? null,
        runDetailReached: false,
        runDetailStatus: null,
      }

      setRuntimeContext(nextContext)

      if (activeStepId !== 'run-action') return

      const nextStepId = runId ? 'live-run' : 'runs-fallback'
      const nextStep = getProductTourStep(nextStepId, nextContext)
      if (nextStep) persistActiveStep(nextStep, undefined, nextContext)
    },
    [activeStepId, persistActiveStep, runtimeContext],
  )

  const recordRunDetailStatus = useCallback((status: string | null | undefined) => {
    const nextStatus = status ?? null
    setRuntimeContext((current) => {
      if (current.runDetailReached && current.runDetailStatus === nextStatus) return current

      return {
        ...current,
        runDetailReached: true,
        runDetailStatus: nextStatus,
      }
    })
  }, [])

  useEffect(() => {
    if (autoStartChecked || activeStepId) return

    const persisted = readProductTourStateCookie()
    if (persisted?.skippedAt || persisted?.completedAt) {
      setAutoStartChecked(true)
      return
    }

    if (persisted?.activeStepId) {
      const persistedStep = getProductTourStep(persisted.activeStepId, runtimeContext)
      if (persistedStep) {
        persistActiveStep(persistedStep, persisted.lastStartedAt)
      }
      setAutoStartChecked(true)
      return
    }

    if (hideHeader || !PRODUCT_TOUR_AUTO_START_PATHS.includes(pathname as never)) return

    persistActiveStep(getFirstProductTourStep(runtimeContext), new Date().toISOString())
    setAutoStartChecked(true)
  }, [activeStepId, autoStartChecked, hideHeader, pathname, persistActiveStep, runtimeContext])

  useEffect(() => {
    if (!activeStepId || runtimeContext.exampleTestId !== undefined) return

    let cancelled = false

    fetchTestFiles()
      .then((data) => {
        if (cancelled) return
        const example = data.files.find(
          (file) => file.name === 'Example passing test' && Boolean(file.testId),
        )
        setRuntimeContext((current) =>
          current.exampleTestId === undefined
            ? { ...current, exampleTestId: example?.testId ?? null }
            : current,
        )
      })
      .catch(() => {
        if (cancelled) return
        setRuntimeContext((current) =>
          current.exampleTestId === undefined ? { ...current, exampleTestId: null } : current,
        )
      })

    return () => {
      cancelled = true
    }
  }, [activeStepId, runtimeContext.exampleTestId])

  useEffect(() => {
    if (!activeStepId) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        skipTour()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeStepId, skipTour])

  const value = useMemo<ProductTourContextValue>(
    () => ({
      isActive: Boolean(activeStep),
      activeStepId,
      activeStep,
      visibleSteps,
      pathname,
      startTour,
      restartTour,
      skipTour,
      completeTour,
      nextStep,
      backStep,
      advanceAfterRunStarted,
      recordRunDetailStatus,
    }),
    [
      activeStep,
      activeStepId,
      advanceAfterRunStarted,
      backStep,
      completeTour,
      nextStep,
      pathname,
      restartTour,
      recordRunDetailStatus,
      skipTour,
      startTour,
      visibleSteps,
    ],
  )

  return <ProductTourContext.Provider value={value}>{children}</ProductTourContext.Provider>
}

export function useProductTour() {
  const context = useContext(ProductTourContext)
  if (!context) throw new Error('useProductTour must be used within a ProductTourProvider')

  return context
}

export function useOptionalProductTour() {
  return useContext(ProductTourContext)
}

export function ProductTourOverlay() {
  const tour = useProductTour()
  const [anchorPlacement, setAnchorPlacement] = useState<AnchorPlacement | null>(null)
  const step = tour.activeStep

  useEffect(() => {
    if (!step || step.centered || !step.targetId) {
      setAnchorPlacement(null)
      return
    }

    let animationFrame = 0
    const selector = `[data-tour-id="${step.targetId}"]`

    const measureAnchor = () => {
      animationFrame = 0
      const anchor = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
        isMeasurableAnchor,
      )
      if (!anchor) {
        setAnchorPlacement(null)
        return
      }

      anchor.scrollIntoView({ block: 'center', inline: 'nearest' })
      const rect = anchor.getBoundingClientRect()
      const nextPlacement = {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      }
      setAnchorPlacement((current) =>
        areAnchorPlacementsEqual(current, nextPlacement) ? current : nextPlacement,
      )
    }

    const scheduleMeasure = () => {
      if (!animationFrame) {
        animationFrame = window.requestAnimationFrame(measureAnchor)
      }
    }

    measureAnchor()
    const observer = new MutationObserver((mutations) => {
      if (mutations.every(isProductTourOverlayMutation)) return
      scheduleMeasure()
    })
    observer.observe(document.body, { attributes: true, childList: true, subtree: true })
    window.addEventListener('resize', scheduleMeasure)

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [step, tour.pathname])

  if (!step) return null

  const cardStyle = productTourCardStyle
  const stepIndex = tour.visibleSteps.findIndex((tourStep) => tourStep.id === step.id)
  const visibleStepIndex = Math.max(0, stepIndex)
  const isLastStep = visibleStepIndex === tour.visibleSteps.length - 1

  return (
    <div className="pointer-events-none fixed inset-0 z-40" data-product-tour-overlay="true">
      {anchorPlacement ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed animate-product-tour-highlight-pulse rounded-[2px] border border-primary/80"
          data-testid="product-tour-highlight"
          style={{
            top: anchorPlacement.top,
            left: anchorPlacement.left,
            width: anchorPlacement.width,
            height: anchorPlacement.height,
          }}
        />
      ) : null}
      <section
        role="dialog"
        aria-modal="false"
        aria-labelledby="product-tour-title"
        className="pointer-events-auto fixed flex max-w-[calc(100vw-32px)] flex-col gap-4 rounded-[4px] border border-border bg-popover p-4 text-popover-foreground shadow-md"
        style={cardStyle}
      >
        <div className="space-y-2">
          <h2 id="product-tour-title" className="text-[18px] leading-[1.2] font-semibold">
            {step.title}
          </h2>
          <p className="text-[14px] leading-[1.5] text-muted-foreground">{step.body}</p>
        </div>
        {step.action ? (
          <div>
            <Button variant="outline" size="sm" asChild>
              <a href={step.action.href} target="_blank" rel="noopener noreferrer">
                {step.action.icon === 'github' ? <FaGithub className="size-4" /> : null}
                {step.action.label}
              </a>
            </Button>
          </div>
        ) : null}
        <div
          aria-label={`Tour progress ${visibleStepIndex + 1} of ${tour.visibleSteps.length}`}
          className="flex items-center gap-1"
        >
          {tour.visibleSteps.map((tourStep, index) => (
            <span
              key={tourStep.id}
              aria-hidden="true"
              className={cn(
                'size-1.5 rounded-full',
                index === visibleStepIndex ? 'bg-primary' : 'bg-muted-foreground/35',
              )}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={tour.skipTour}>
              Skip
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={tour.restartTour}>
              Restart
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={visibleStepIndex <= 0}
              onClick={tour.backStep}
            >
              Back
            </Button>
            <Button type="button" size="sm" onClick={isLastStep ? tour.completeTour : tour.nextStep}>
              {isLastStep ? 'Done' : step.id === 'intro' ? 'Start tour' : 'Next'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

const productTourCardStyle: CSSProperties = {
  right: 16,
  bottom: 16,
  width: 'min(360px, calc(100vw - 32px))',
}

function shouldPersistProductTourRoute(step: ProductTourStep): boolean {
  return typeof step.route === 'string'
}

function isMeasurableAnchor(anchor: HTMLElement): boolean {
  const style = window.getComputedStyle(anchor)
  if (anchor.hidden || style.display === 'none' || style.visibility === 'hidden') return false

  const rect = anchor.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function areAnchorPlacementsEqual(current: AnchorPlacement | null, next: AnchorPlacement): boolean {
  if (!current) return false

  return Math.abs(current.top - next.top) < 0.5
    && Math.abs(current.left - next.left) < 0.5
    && Math.abs(current.width - next.width) < 0.5
    && Math.abs(current.height - next.height) < 0.5
}

function isProductTourOverlayMutation(mutation: MutationRecord): boolean {
  const target = mutation.target
  return target instanceof Element
    && Boolean(target.closest('[data-product-tour-overlay="true"]'))
}
