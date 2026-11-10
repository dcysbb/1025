import { useState } from 'react'
import StagePanel from './StagePanel'
import LbtekPanel from './LbtekPanel'

export default function StagePage({auth,connected}:{auth:boolean;connected:boolean}){
  const [device,setDevice]=useState(()=>{try{return localStorage.getItem('stage-device')==='lbtek'?'lbtek':'pdxc3'}catch{return 'pdxc3'}})
  return <><div className="stage-device-tabs" role="tablist" aria-label="位移台控制器">{[['pdxc3','Thorlabs PDXC3'],['lbtek','LBTEK EM-CS5-3']].map(([id,label])=><button key={id} id={`stage-tab-${id}`} role="tab" aria-selected={device===id} aria-controls="stage-device-panel" className={`button ${device===id?'button--primary':'button--quiet'}`} onClick={()=>{setDevice(id);try{localStorage.setItem('stage-device',id)}catch{}}}>{label}</button>)}</div><div id="stage-device-panel" role="tabpanel" aria-labelledby={`stage-tab-${device}`}>{device==='lbtek'?<LbtekPanel auth={auth} connected={connected}/>:<StagePanel auth={auth} connected={connected}/>}</div></>
}
