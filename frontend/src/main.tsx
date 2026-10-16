import './App.css'
import './HardwarePanel.css'
import './StagePanel.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './Appearance.css'
import './Chart.css'
import './StageWorkbench.css'
import './Motion.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
