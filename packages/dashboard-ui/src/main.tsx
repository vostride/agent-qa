import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "@/app"
import { startLanguage } from "@/i18n"
import "@/styles/globals.css"

void startLanguage().finally(() => {
  createRoot(document.getElementById("app")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )

  const splash = document.getElementById('splash')
  if (splash) {
    splash.classList.add('splash-hide')
    splash.addEventListener('transitionend', () => splash.remove())
  }
})
