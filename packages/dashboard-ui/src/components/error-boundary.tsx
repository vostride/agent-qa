import { useRouteError, isRouteErrorResponse, useNavigate } from "react-router"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTranslation } from "@/i18n"

export function RouteErrorBoundary() {
  const error = useRouteError()
  const navigate = useNavigate()
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-8">
      <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
      <h2 className="text-xl font-semibold mb-2">{t('common.error.title')}</h2>
      <p className="text-muted-foreground text-center mb-6 max-w-md">
        {isRouteErrorResponse(error)
          ? `${error.status}: ${error.statusText}`
          : error instanceof Error
            ? error.message
            : t('common.error.unexpected')}
      </p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => navigate(-1)}>
          {t('common.error.goBack')}
        </Button>
        <Button onClick={() => window.location.reload()}>{t('common.error.tryAgain')}</Button>
      </div>
    </div>
  )
}
