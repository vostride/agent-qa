import { useRouteError, isRouteErrorResponse, useNavigate } from "react-router"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"

export function RouteErrorBoundary() {
  const error = useRouteError()
  const navigate = useNavigate()

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-8">
      <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
      <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
      <p className="text-muted-foreground text-center mb-6 max-w-md">
        {isRouteErrorResponse(error)
          ? `${error.status}: ${error.statusText}`
          : error instanceof Error
            ? error.message
            : "An unexpected error occurred"}
      </p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => navigate(-1)}>
          Go Back
        </Button>
        <Button onClick={() => window.location.reload()}>Try Again</Button>
      </div>
    </div>
  )
}
