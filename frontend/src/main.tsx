import './App.css'
import './HelpTooltip.css'
import './HardwarePanel.css'
import './StagePanel.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './Appearance.css'
import './Chart.css'
import './StageWorkbench.css'
import './StageAdvanced.css'
import './Motion.css'
import './SystemMenu.css'
import './AnalogManualPanel.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
