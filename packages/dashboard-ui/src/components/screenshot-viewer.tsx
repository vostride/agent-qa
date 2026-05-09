import { useState, useRef, useEffect, useCallback } from "react"
import { Camera, Crosshair, Maximize2, Search, X } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import type { StepAnnotation } from "@/lib/api"
import { resolveScreenshotSrc } from "@/lib/artifact-media"
import { cn } from "@/lib/utils"

interface ScreenshotViewerProps {
  screenshotPath: string
  annotation?: StepAnnotation | null
  refLabel?: string
  className?: string
}

export function ScreenshotViewer({
  screenshotPath,
  annotation,
  refLabel,
  className,
}: ScreenshotViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [instanceId] = useState(() => Math.random().toString(36).slice(2, 8))
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })
  const [isHovering, setIsHovering] = useState(false)
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [magnifierOn, setMagnifierOn] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [annotationsVisible, setAnnotationsVisible] = useState(true)

  const src = resolveScreenshotSrc(screenshotPath)

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
    },
    [],
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

  const viewportWidth =
    annotation?.viewport?.width || naturalSize.width || 1
  const viewportHeight =
    annotation?.viewport?.height || naturalSize.height || 1

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

  const scaleX = renderedW / viewportWidth
  const scaleY = renderedH / viewportHeight

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
  const annotationOverlays = imageLoaded && annotation && annotationsVisible && (
    <>
      {annotation.failureHighlight && (
        <div
          className="absolute border-2 border-red-500/70 rounded-sm bg-red-500/15 animate-pulse pointer-events-none"
          style={{
            left: offsetX + annotation.failureHighlight.x * scaleX,
            top: offsetY + annotation.failureHighlight.y * scaleY,
            width: annotation.failureHighlight.width * scaleX,
            height: annotation.failureHighlight.height * scaleY,
          }}
        />
      )}
      {annotation.boundingBox && (
        <>
          <div
            className="absolute border-2 border-emerald-500/70 rounded-sm bg-emerald-500/10 pointer-events-none"
            style={{
              left: offsetX + annotation.boundingBox.x * scaleX,
              top: offsetY + annotation.boundingBox.y * scaleY,
              width: annotation.boundingBox.width * scaleX,
              height: annotation.boundingBox.height * scaleY,
            }}
          />
          {refLabel && (
            <div
              className="absolute text-[10px] font-mono font-bold text-white bg-emerald-600/90 px-1 rounded-sm pointer-events-none leading-tight"
              style={{
                left: offsetX + annotation.boundingBox.x * scaleX,
                top: offsetY + annotation.boundingBox.y * scaleY - 14,
              }}
            >
              {refLabel}
            </div>
          )}
        </>
      )}
      {annotation.clickPoint && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: offsetX + annotation.clickPoint.x * scaleX,
            top: offsetY + annotation.clickPoint.y * scaleY,
            transform: "translate(-50%, -50%)",
            zIndex: 1,
          }}
        >
          <div className="relative">
            <div className="w-2.5 h-2.5 rounded-full bg-turquoise-500 border-[1.5px] border-black/60 shadow-[0_0_0_1px_rgba(255,255,255,0.4)]" />
            <div className="absolute rounded-full border-2 border-turquoise-500/50 animate-ping" style={{ width: 22, height: 22, left: -8.5, top: -8.5 }} />
          </div>
        </div>
      )}
      {/* Gesture annotations — animated indicators */}
      {/* Swipe/Drag: start dot + trailing dots along path + end dot with ping */}
      {annotation.startPoint && annotation.endPoint && (() => {
        const color = annotation.type === 'drag' ? 'oklch(0.65 0.19 150)' : 'oklch(0.65 0.19 210)'
        const colorFaded = annotation.type === 'drag' ? 'oklch(0.65 0.19 150 / 0.4)' : 'oklch(0.65 0.19 210 / 0.4)'
        const sx = offsetX + annotation.startPoint!.x * scaleX
        const sy = offsetY + annotation.startPoint!.y * scaleY
        const ex = offsetX + annotation.endPoint!.x * scaleX
        const ey = offsetY + annotation.endPoint!.y * scaleY
        const trailCount = 4
        return (
          <>
            {/* Trail dots — staggered fade animation along path */}
            {Array.from({ length: trailCount }, (_, i) => {
              const t = (i + 1) / (trailCount + 1)
              const x = sx + (ex - sx) * t
              const y = sy + (ey - sy) * t
              return (
                <div key={`trail-${i}`} className="absolute pointer-events-none animate-gesture-trail" style={{
                  left: x, top: y, transform: 'translate(-50%, -50%)', zIndex: 1,
                  animationDelay: `${i * 0.15}s`,
                }}>
                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: colorFaded }} />
                </div>
              )
            })}
            {/* Start dot */}
            <div className="absolute pointer-events-none" style={{ left: sx, top: sy, transform: 'translate(-50%, -50%)', zIndex: 1 }}>
              <div className="w-2.5 h-2.5 rounded-full border-[1.5px] border-black/50 shadow-[0_0_0_1px_rgba(255,255,255,0.3)]" style={{ backgroundColor: color }} />
            </div>
            {/* End dot with ping */}
            <div className="absolute pointer-events-none" style={{ left: ex, top: ey, transform: 'translate(-50%, -50%)', zIndex: 1 }}>
              <div className="relative">
                <div className="w-2 h-2 rounded-full border-[1.5px] border-black/50 shadow-[0_0_0_1px_rgba(255,255,255,0.3)]" style={{ backgroundColor: color }} />
                <div className="absolute rounded-full border-[1.5px] animate-ping" style={{ borderColor: colorFaded, width: 18, height: 18, left: -7, top: -7 }} />
              </div>
            </div>
          </>
        )
      })()}
      {/* Scroll: center dot with ripple + long thin arrow in scroll direction */}
      {annotation.direction && !annotation.startPoint && (() => {
        const cx = annotation.clickPoint
          ? offsetX + annotation.clickPoint.x * scaleX
          : offsetX + renderedW / 2
        const cy = annotation.clickPoint
          ? offsetY + annotation.clickPoint.y * scaleY
          : offsetY + renderedH / 2
        const arrowLen = Math.min(renderedH, renderedW) * 0.35
        const offsets: Record<string, [number, number]> = {
          up: [0, -arrowLen], down: [0, arrowLen], left: [-arrowLen, 0], right: [arrowLen, 0],
        }
        const [dx, dy] = offsets[annotation.direction!] || [0, 0]
        return (
          <>
            {/* Arrow line + small arrowhead via SVG */}
            <svg className="absolute pointer-events-none" style={{ left: offsetX, top: offsetY, zIndex: 1 }} width={renderedW} height={renderedH}>
              <defs>
                <marker id={`scroll-arrow-border-${instanceId}`} markerWidth="16" markerHeight="14" refX="14" refY="7" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M1 1 L14 7 L1 13" fill="none" stroke="oklch(0 0 0 / 0.5)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
                </marker>
                <marker id={`scroll-arrow-${instanceId}`} markerWidth="16" markerHeight="14" refX="14" refY="7" orient="auto" markerUnits="userSpaceOnUse">
                  <path d="M1 1 L14 7 L1 13" fill="none" stroke="oklch(0.719 0.119 209.8)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                </marker>
              </defs>
              {/* Black border stroke */}
              <line
                x1={cx - offsetX} y1={cy - offsetY}
                x2={cx - offsetX + dx} y2={cy - offsetY + dy}
                stroke="oklch(0 0 0 / 0.5)" strokeWidth={4} strokeLinecap="round"
                markerEnd={`url(#scroll-arrow-border-${instanceId})`}
              />
              {/* Colored body line — matches tap dot blue */}
              <line
                x1={cx - offsetX} y1={cy - offsetY}
                x2={cx - offsetX + dx} y2={cy - offsetY + dy}
                stroke="oklch(0.719 0.119 209.8 / 0.8)" strokeWidth={2.5} strokeLinecap="round"
                markerEnd={`url(#scroll-arrow-${instanceId})`}
              />
            </svg>
            {/* Center dot with ripple — identical to tap click dot */}
            <div className="absolute pointer-events-none" style={{ left: cx, top: cy, transform: 'translate(-50%, -50%)', zIndex: 2 }}>
              <div className="relative flex items-center justify-center" style={{ width: 22, height: 22 }}>
                <div className="w-2.5 h-2.5 rounded-full bg-turquoise-500 border-[1.5px] border-black/60 shadow-[0_0_0_1px_rgba(255,255,255,0.4)]" />
                <div className="absolute inset-0 rounded-full border-2 border-turquoise-500/50 animate-ping" />
              </div>
            </div>
          </>
        )
      })()}
      {/* Pinch: two dots that pulse outward/inward */}
      {annotation.pinchScale && (() => {
        const cx = annotation.startPoint ? offsetX + annotation.startPoint.x * scaleX : offsetX + renderedW / 2
        const cy = annotation.startPoint ? offsetY + annotation.startPoint.y * scaleY : offsetY + renderedH / 2
        const spread = 24
        const isOut = annotation.pinchScale === 'out'
        const animClass = isOut ? 'animate-gesture-pinch-out' : 'animate-gesture-pinch-in'
        return (
          <>
            <div className={`absolute pointer-events-none ${animClass}`} style={{ left: cx - spread, top: cy, transform: 'translate(-50%, -50%)', zIndex: 1 }}>
              <div className="relative">
                <div className="w-2.5 h-2.5 rounded-full bg-turquoise-500 border-[1.5px] border-black/50 shadow-[0_0_0_1px_rgba(255,255,255,0.3)]" />
                <div className="absolute rounded-full border-[1.5px] border-turquoise-500/40 animate-ping" style={{ width: 18, height: 18, left: -6.5, top: -6.5 }} />
              </div>
            </div>
            <div className={`absolute pointer-events-none ${animClass}`} style={{ left: cx + spread, top: cy, transform: 'translate(-50%, -50%)', zIndex: 1, animationDirection: 'reverse' }}>
              <div className="relative">
                <div className="w-2.5 h-2.5 rounded-full bg-turquoise-500 border-[1.5px] border-black/50 shadow-[0_0_0_1px_rgba(255,255,255,0.3)]" />
                <div className="absolute rounded-full border-[1.5px] border-turquoise-500/40 animate-ping" style={{ width: 18, height: 18, left: -6.5, top: -6.5 }} />
              </div>
            </div>
          </>
        )
      })()}
    </>
  )

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
          onError={() => setImageError(true)}
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
