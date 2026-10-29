import { useState, useRef, useEffect, useCallback } from "react"
import { Camera, Crosshair, Maximize2, Search, X } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import type { StepAnnotation } from "@/lib/api"
import { MediaAnnotationOverlay } from "./media-annotation-overlay"
import { MediaViewport } from './media-viewport'
import { cn } from "@/lib/utils"

// THE VIEWER TAKES A MINTED URL, NOT A PATH.
//
// It used to take a filesystem-ish path and build a serving URL out of it by splitting on slashes
// and guessing which segment was the run. Refs are the only artifact addressing now, and the ONE
// minter is the route map: the caller resolves a ref to a `src` and hands it down. So this
// component builds no URL at all, which is the property 405-13 greps the source tree for.
interface ScreenshotViewerProps {
  /** An already-minted, same-origin URL. Never a path, never anything this file assembles. */
  src: string
  annotation?: StepAnnotation | null
  refLabel?: string
  className?: string
  /**
   * Told when the image request FAILED.
   *
   * A blob that was garbage-collected or never written answers 404, and the owner of the pane needs
   * to say "screenshot unavailable" in its own words rather than leave a broken image element on
   * the page. The viewer still paints its own fallback when nobody is listening, so a caller that
   * does not pass this cannot produce a broken `img` by omission.
   */
  onUnavailable?: () => void
  embedded?: { magnifier: boolean; annotationsVisible: boolean; fullscreen: boolean; onAvailability?: (available: boolean) => void }
}

export function ScreenshotViewer({
  src,
  annotation,
  refLabel,
  className,
  onUnavailable,
  embedded,
}: ScreenshotViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })
  const [isHovering, setIsHovering] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [magnifierOn, setMagnifierOn] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [annotationsVisible, setAnnotationsVisible] = useState(true)

  // A NEW `src` IS A NEW QUESTION. The load and error flags describe ONE request; carrying
  // them across a swap would leave the previous image's failure painted over a blob that was never
  // asked for, which reads as "this evidence is gone" about the wrong sub-action.
  useEffect(() => {
    setImageLoaded(false)
    setImageError(false)
  }, [src])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [fullscreen])

  const handleImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight })
      setImageLoaded(true)
      embedded?.onAvailability?.(true)
    },
    [embedded?.onAvailability],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      setMousePos({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      })
    },
    [],
  )

  const containerW = containerSize.width
  const containerH = containerSize.height
  const imgAspect = naturalSize.width / (naturalSize.height || 1)
  const containerAspect = containerW / (containerH || 1)

  let renderedW = containerW
  let renderedH = containerH
  let offsetX = 0
  let offsetY = 0

  if (imageLoaded && naturalSize.width > 0) {
    if (imgAspect > containerAspect) {
      renderedW = containerW
      renderedH = containerW / imgAspect
      offsetY = (containerH - renderedH) / 2
    } else {
      renderedH = containerH
      renderedW = containerH * imgAspect
      offsetX = (containerW - renderedW) / 2
    }
  }


  const zoomSize = 150
  const zoomScale = 2.5
  const zoomBgWidth = renderedW * zoomScale
  const zoomBgHeight = renderedH * zoomScale
  const zoomBgX = -((mousePos.x - offsetX) * zoomScale - zoomSize / 2)
  const zoomBgY = -((mousePos.y - offsetY) * zoomScale - zoomSize / 2)

  let lensX = mousePos.x + 20
  let lensY = mousePos.y + 20
  if (lensX + zoomSize > containerW) lensX = mousePos.x - zoomSize - 10
  if (lensY + zoomSize > containerH) lensY = mousePos.y - zoomSize - 10
  if (lensX < 0) lensX = 0
  if (lensY < 0) lensY = 0

  const showMagnifier = magnifierOn && isHovering && imageLoaded

  if (imageError) {
    return (
      <div
        className={cn(
          "relative rounded-lg border bg-muted/20 flex items-center justify-center",
          className,
        )}
        style={{ aspectRatio: '16 / 9', maxHeight: '50vh' }}
      >
        <div className="text-muted-foreground flex flex-col items-center gap-2">
          <Camera className="h-8 w-8" />
          <span className="text-sm">Screenshot unavailable</span>
        </div>
      </div>
    )
  }

  const hasAnnotations = !!(annotation?.clickPoint || annotation?.boundingBox || annotation?.failureHighlight || annotation?.startPoint || annotation?.endPoint || annotation?.direction || annotation?.pinchScale)
  const annotationOverlays = imageLoaded && annotation && annotationsVisible && <MediaAnnotationOverlay annotation={annotation} refLabel={refLabel} renderedW={renderedW} renderedH={renderedH} offsetX={offsetX} offsetY={offsetY} />

  if (embedded) return <MediaViewport width={naturalSize.width} height={naturalSize.height}
    magnifier={embedded.magnifier} fullscreen={embedded.fullscreen} mediaKey={src}
    annotation={imageLoaded && embedded.annotationsVisible ? annotation ?? undefined : undefined}>
    <img src={src} alt='Step screenshot' className='h-full w-full object-contain'
      onLoad={handleImageLoad} onError={() => { setImageError(true); embedded.onAvailability?.(false); onUnavailable?.() }} />
  </MediaViewport>

  return (
    <>
      <div
        ref={containerRef}
        className={cn(
          "relative overflow-hidden rounded-lg border bg-muted/20 group w-full",
          className,
        )}
        style={{
          aspectRatio: imageLoaded && naturalSize.width > 0
            ? `${naturalSize.width} / ${naturalSize.height}`
            : '16 / 9',
          maxHeight: '50vh',
        }}
        onMouseMove={magnifierOn ? handleMouseMove : undefined}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
      >
        {!imageLoaded && (
          <Skeleton className="absolute inset-0 rounded-lg" />
        )}

        <img
          src={src}
          alt="Step screenshot"
          className={cn(
            "w-full h-full object-contain",
            !imageLoaded && "opacity-0",
          )}
          onLoad={handleImageLoad}
          onError={() => {
            setImageError(true)
            onUnavailable?.()
          }}
        />

        {annotationOverlays}

        {showMagnifier && (
          <div
            className="absolute rounded-full border-2 border-primary/50 shadow-lg pointer-events-none z-10"
            style={{
              width: zoomSize,
              height: zoomSize,
              left: lensX,
              top: lensY,
              backgroundImage: `url(${src})`,
              backgroundSize: `${zoomBgWidth}px ${zoomBgHeight}px`,
              backgroundPosition: `${zoomBgX}px ${zoomBgY}px`,
              backgroundRepeat: "no-repeat",
            }}
          />
        )}

        {/* Toolbar buttons — visible on hover */}
        {imageLoaded && (
          <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
            {hasAnnotations && (
              <Button
                variant="secondary"
                size="icon-sm"
                className="h-7 w-7 bg-background/80 backdrop-blur-sm"
                onClick={(e) => { e.stopPropagation(); setAnnotationsVisible(!annotationsVisible) }}
                title={annotationsVisible ? "Hide annotations" : "Show annotations"}
              >
                <Crosshair className={cn("h-3.5 w-3.5", annotationsVisible && "text-primary")} />
              </Button>
            )}
            <Button
              variant="secondary"
              size="icon-sm"
              className="h-7 w-7 bg-background/80 backdrop-blur-sm"
              onClick={(e) => { e.stopPropagation(); setMagnifierOn(!magnifierOn) }}
              title={magnifierOn ? "Disable magnifier" : "Enable magnifier"}
            >
              <Search className={cn("h-3.5 w-3.5", magnifierOn && "text-primary")} />
            </Button>
            <Button
              variant="secondary"
              size="icon-sm"
              className="h-7 w-7 bg-background/80 backdrop-blur-sm"
              onClick={(e) => { e.stopPropagation(); setFullscreen(true) }}
              title="View full size"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* Fullscreen overlay */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setFullscreen(false)}
        >
          <Button
            variant="secondary"
            size="icon-sm"
            className="absolute top-4 right-4 h-8 w-8 bg-background/80 backdrop-blur-sm z-10"
            onClick={() => setFullscreen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
          <img
            src={src}
            alt="Step screenshot (full size)"
            className="object-contain rounded-lg"
            style={{ maxWidth: '90vw', maxHeight: '90vh' }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}
