import './index.css'
import './App.css'
import './Appearance.css'
import './Motion.css'
import './HardwarePanel.css'
import './HelpTooltip.css'
import './StagePanel.css'
import './LbtekPanel.css'
import './LbtekStandalone.css'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Moon, Sun } from 'lucide-react'
import LbtekPanel from './LbtekPanel'
import { apiRequest, errorMessage } from './apiClient'

export default function Standalone(){
  const [tab,setTab]=useState('control'), [theme,setTheme]=useState('graphite'), [online,setOnline]=useState(false), [error,setError]=useState('')
  useEffect(()=>{document.documentElement.dataset.theme=theme},[theme])
  useEffect(()=>{
    let cancelled=false,timer:ReturnType<typeof setTimeout>
    async function poll(){try{const result=await apiRequest<{ok:boolean;scope:string}>('/api/health');if(result.scope!=='lbtek')throw new Error('此地址不是独立 LBTEK 后台');if(!cancelled){setOnline(result.ok);setError('')}}catch(e){if(!cancelled){setOnline(false);setError(errorMessage(e,'连接 LBTEK 后台失败'))}}if(!cancelled)timer=setTimeout(()=>void poll(),2000)}
    void poll();return()=>{cancelled=true;clearTimeout(timer)}
  },[])
  return <main className="lbtek-standalone"><header className="glass-panel lbtek-standalone-header"><div><h1>1025控制台 <span>LBTEK</span></h1><p>EM-CS5-3 独立控制面板</p></div><div className="stage-actions"><a className="button button--quiet" href="http://127.0.0.1:8770/">主控制台</a><button className="button" aria-label={theme==='graphite'?'切换为浅色':'切换为深色'} onClick={()=>setTheme(theme==='graphite'?'light':'graphite')}>{theme==='graphite'?<Sun size={17}/>:<Moon size={17}/>}</button><span className={online?'stage-state--on':'subtle-note'}>{online?'后台在线':'后台离线'}</span></div></header>
    {error&&<p className="inline-error" role="alert">{error}</p>}<div className="stage-device-tabs" role="tablist" aria-label="LBTEK 菜单">{[['control','运动控制'],['connection','设备连接']].map(([id,name])=><button key={id} className={`button ${tab===id?'button--primary':'button--quiet'}`} role="tab" aria-selected={tab===id} aria-controls={`lbtek-${id}`} onClick={()=>setTab(id)}>{name}</button>)}</div>
    {tab==='control'&&<div id="lbtek-control" role="tabpanel"><LbtekPanel auth connected={online}/></div>}
    <div id="lbtek-connection" role="tabpanel" hidden={tab!=='connection'}><LbtekPanel auth connected={online} configuration/></div>
  </main>
}
createRoot(document.getElementById('root')!).render(<StrictMode><Standalone/></StrictMode>)
