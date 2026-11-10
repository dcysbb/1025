import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Home, Plug, RefreshCw, Square } from 'lucide-react'
import { apiRequest, errorMessage } from './apiClient'
import { applyConnection, changedFields, connectionMessage } from './deviceConnections'
import { Disclosure } from './Motion'
import HelpTooltip from './HelpTooltip'

export type LbtekConfig = { mode:'real'|'simulation'; usb_port:number|null; max_distance:number; names:string[]; units:('mm'|'°')[] }
export type LbtekChannel = { channel:number; can_run:boolean; stopped:boolean; enabled:boolean; home:boolean; limit_left:boolean; limit_right:boolean; home_sensor:boolean; position:number; speed:number; acceleration:number }
type RecordItem = { timestamp:string; channel:number; operation:string; value:number|null; mode:string; result:string; reason:string|null }
export type LbtekState = { config:LbtekConfig; connected:boolean; channels:LbtekChannel[]; error:string|null; stale:boolean; motion_pending:number[]; uncertain:boolean; busy:boolean; lease_id:string|null; usb_port?:number; axis_base?:number; rocker_enabled:boolean; records:RecordItem[] }
const request = <T,>(path:string, body?:unknown) => apiRequest<T>(`/api/lbtek-stage${path}`, { method:body === undefined ? 'GET' : 'POST', body:body === undefined ? undefined : JSON.stringify(body), operation:'LBTEK 位移台操作', timeoutMs:25000 })
const labels:Record<string,string> = {relative:'相对移动',absolute:'绝对定位',drive:'按住移动',home:'回零'}
const results:Record<string,string> = {submitted:'请求已下发',rejected:'未下发',unconfirmed:'结果未确认'}
const number = (value:number|undefined) => value === undefined || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN',{maximumFractionDigits:6})
const validState = (value:LbtekState) => !!value?.config && Array.isArray(value.config.units) && value.config.units.length === 3 && Array.isArray(value.channels) && Array.isArray(value.motion_pending)

export default function LbtekPanel({auth,connected,configuration=false,onDirtyChange}:{auth:boolean;connected:boolean;configuration?:boolean;onDirtyChange?:(dirty:boolean)=>void}) {
  const [state,setState] = useState<LbtekState|null>(null), [draft,setDraft] = useState<LbtekConfig|null>(null), [saved,setSaved] = useState<LbtekConfig|null>(null)
  const [fresh,setFresh] = useState(false), [readError,setReadError] = useState(''), [error,setError] = useState(''), [message,setMessage] = useState('')
  const [busy,setBusy] = useState(false), [stopping,setStopping] = useState(false)
  const [holding,setHolding] = useState<{channel:number;direction:number}|null>(null)
  const moving = useRef(false)
  const [ports,setPorts] = useState<number[]>([]), [scanning,setScanning] = useState(false)
  const command = useRef(false), epoch = useRef(0), mounted = useRef(true), lastRead = useRef(0), baseline = useRef<LbtekConfig|null>(null)
  const hold = useRef<{timer?:ReturnType<typeof setTimeout>; started:boolean; token:string; channel:number}|null>(null)
  const leaseTimer = useRef<ReturnType<typeof setInterval>|null>(null)
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved)
  useEffect(()=>{onDirtyChange?.(dirty)},[dirty,onDirtyChange])
  const accept = useCallback((next:LbtekState)=>{
    if(!validState(next))throw new Error('LBTEK 状态格式异常，请检查后台版本')
    setState(next);setFresh(true);lastRead.current=Date.now();setReadError('');moving.current=!!next.motion_pending.length
    if(!baseline.current){baseline.current=next.config;setSaved(next.config);setDraft(next.config)}
  },[])
  useEffect(()=>{
    mounted.current=true;let cancelled=false;let timer:ReturnType<typeof setTimeout>
    async function poll(){
      const version=epoch.current
      try{const next=await request<LbtekState>('');if(!cancelled && version===epoch.current && !command.current)accept(next)}
      catch(e){if(!cancelled&&version===epoch.current&&!command.current){setFresh(false);setReadError(errorMessage(e,'读取 LBTEK 状态失败'))}}
      if(!cancelled)timer=setTimeout(()=>void poll(),hold.current?.started||moving.current?150:500)
    }
    void poll()
    const staleTimer=setInterval(()=>{if(Date.now()-lastRead.current>2200)setFresh(false)},250)
    return()=>{cancelled=true;mounted.current=false;clearTimeout(timer);clearInterval(staleTimer)}
  },[accept])

  const clearHold = useCallback(()=>{
    const prior=hold.current;hold.current=null;if(mounted.current)setHolding(null)
    if(prior?.timer)clearTimeout(prior.timer)
    if(leaseTimer.current){clearInterval(leaseTimer.current);leaseTimer.current=null}
    return prior
  },[])
  const stop = useCallback(async(channel?:number)=>{
    clearHold();++epoch.current;setStopping(true);setError('');setMessage('')
    try{
      const next=configuration
        ? await apiRequest<LbtekState>('/api/devices/lbtek/cancel',{method:'POST',body:'{}',operation:'停止 LBTEK 连接'})
        : await request<LbtekState>('/stop',channel?{channel}:{})
      if(mounted.current){accept(next);setMessage('停止已下发，状态读回空闲')}
    }catch(e){if(mounted.current){setError(errorMessage(e,'LBTEK 停止未确认'));setFresh(false)}}
    finally{if(mounted.current)setStopping(false)}
  },[accept,clearHold,configuration])
  const release = useCallback(()=>{
    const prior=clearHold()
    if(prior?.started)void stop()
  },[clearHold,stop])
  useEffect(()=>{
    const hidden=()=>{if(document.hidden)release()}
    window.addEventListener('blur',release);document.addEventListener('visibilitychange',hidden)
    return()=>{window.removeEventListener('blur',release);document.removeEventListener('visibilitychange',hidden);release()}
  },[release,stop,auth,connected,configuration])
  useEffect(()=>{if(!auth||!connected||!fresh||state?.uncertain)release()},[auth,connected,fresh,state?.uncertain,release])

  async function run(fn:()=>Promise<LbtekState>,success:string){
    if(command.current)return false
    command.current=true;setBusy(true);setError('');setMessage('');const version=++epoch.current
    try{const next=await fn();if(mounted.current&&version===epoch.current){accept(next);setMessage(success);return true}}
    catch(e){if(mounted.current&&version===epoch.current){setError(errorMessage(e,'LBTEK 操作失败'));setFresh(false)}}
    finally{command.current=false;if(mounted.current)setBusy(false)}
    return false
  }
  async function action(channel:number,operation:string,value?:number){
    await run(()=>request('/action',{channel,operation,...(value === undefined?{}:{value})}),'请求已下发，等待控制器状态确认')
  }
  function beginHold(channel:number,direction:number){
    if(hold.current||command.current)return
    const token=globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random()}`
    const item={started:false,token,channel,timer:undefined as ReturnType<typeof setTimeout>|undefined};hold.current=item
    item.timer=setTimeout(()=>{
      if(hold.current!==item)return
      item.started=true;setHolding({channel,direction})
      void run(async()=>{
        const next=await request<LbtekState>('/action',{channel,operation:'drive',value:direction,lease_id:token})
        if(hold.current===item){
          leaseTimer.current=setInterval(()=>{
            if(hold.current!==item)return
            void request('/keepalive',{lease_id:token}).catch(e=>{if(hold.current===item){setError(errorMessage(e,'按住移动续期失败'));release()}})
          },250)
        }
        return next
      },'按住移动中，松开即停止').then(()=>{if(hold.current===item&&!leaseTimer.current)release()})
    },180)
  }
  function endHold(channel:number,direction:number,step:number){
    const prior=clearHold()
    if(!prior)return
    if(prior.started)void stop()
    else void action(channel,'relative',direction*step)
  }
  const baseReason = !auth?'需要操作员权限':!connected?'控制台后台离线':!fresh?'状态已过期，请等待重新读取':!state?.connected?'请先在硬件连接中连接 LBTEK':state.uncertain?'动作结果未确认，请停止并恢复':state.rocker_enabled?'摇杆已接管，请先关闭摇杆控制':stopping?'正在停止':busy||state.busy?'正在提交请求':''
  const patch = <K extends keyof LbtekConfig>(key:K,value:LbtekConfig[K])=>setDraft(prior=>prior&&({...prior,[key]:value}))
  async function scan(){setScanning(true);setError('');try{setPorts((await request<{ports:number[]}>('/devices')).ports)}catch(e){setError(errorMessage(e,'枚举 LBTEK USB 设备失败'))}finally{setScanning(false)}}
  return <div className="lbtek-panel stage-panel">
    <section className="content-panel glass-panel hardware-card" id={configuration?'lbtek-connection-card':undefined}>
      <div className="panel-heading"><div><h2>LBTEK EM-CS5-3</h2><span className="stage-model">三通道步进控制器 · USB</span></div><span className={`stage-state ${fresh&&state?.connected?'stage-state--on':''}`}>{!fresh?'状态待读取':state?.connected?'已连接':'未连接'}{state?.config.mode==='simulation'?' · 模拟':''}</span></div>
      {readError&&<p className="inline-error" role="alert">{readError}</p>}
      {state?.error&&<p className="inline-error" role="alert">{state.error}</p>}
      {configuration&&draft&&<>
        <fieldset className="lbtek-config" disabled={!auth||busy}>
          <label className="field">LBTEK 运行模式<select value={draft.mode} onChange={e=>patch('mode',e.target.value as LbtekConfig['mode'])}><option value="real">真实设备</option><option value="simulation">模拟模式</option></select></label>
          <label className="field">LBTEK USB 设备<select value={draft.usb_port??''} onChange={e=>patch('usb_port',e.target.value===''?null:Number(e.target.value))}><option value="">自动选择唯一设备</option>{[...new Set([...ports,...(draft.usb_port===null?[]:[draft.usb_port])])].map(port=><option value={port} key={port}>USB 设备端口 {port}</option>)}</select></label>
          <label className="field">LBTEK 单次位移上限<input type="number" min="0.000001" max="1000" step="any" value={draft.max_distance} onChange={e=>patch('max_distance',Number(e.target.value))}/></label>
        </fieldset>
        <Disclosure title="通道名称与单位"><HelpTooltip label="LBTEK 通道单位">单位应与实际位移台一致。直线台使用 mm，旋转台使用 °；此设置只改变标签，不转换 SDK 数值。单次位移上限按各轴单位计算。</HelpTooltip><div className="lbtek-config">{[1,2,3].map(ch=><div key={ch}><label className="field">CH{ch} 名称<input disabled={!auth||busy} maxLength={32} value={draft.names[ch-1]} onChange={e=>patch('names',draft.names.map((v,i)=>i===ch-1?e.target.value:v))}/></label><label className="field">CH{ch} 单位<select disabled={!auth||busy} value={draft.units[ch-1]} onChange={e=>patch('units',draft.units.map((v,i)=>i===ch-1?e.target.value as 'mm'|'°':v))}><option>mm</option><option>°</option></select></label></div>)}</div></Disclosure>
        <div className="hardware-actions"><span className="subtle-note">{dirty?'有未保存的更改':'已保存'}</span><button className="button button--quiet" disabled={!auth||!connected||busy||scanning} onClick={()=>void scan()}><RefreshCw size={15}/>{scanning?'正在刷新…':'刷新 LBTEK 设备'}</button>
          <button className="button button--primary" disabled={!auth||!connected||!fresh||busy||stopping||!Number.isFinite(draft.max_distance)||draft.max_distance<=0||draft.max_distance>1000} onClick={()=>void run(async()=>{const result=await applyConnection<LbtekState>('lbtek',changedFields(baseline.current,draft,['mode','usb_port','max_distance','names','units']));if(result.config_saved){baseline.current=result.state.config;setSaved(result.state.config);setDraft(result.state.config)}if(!result.ok)throw new Error(connectionMessage(result));return result.state},'配置已保存，LBTEK 已连接')}><Plug size={15}/>{busy?'应用中…':`应用并${state?.connected?'重新':''}连接 LBTEK`}</button>
          <button className="button button--quiet" disabled={!auth||!connected||busy||!state?.connected} onClick={()=>void run(()=>apiRequest('/api/devices/lbtek/disconnect',{method:'POST',body:'{}'}),'LBTEK 已断开')}>断开 LBTEK</button>
          <button className="button stage-stop" disabled={!auth||!connected||stopping} onClick={()=>void stop()}>停止 / 取消连接</button></div>
      </>}
      {!configuration&&<div className="stage-actions lbtek-toolbar"><span className="mode-badge" data-mode={state?.config.mode}>{!state?'模式待读取':state.config.mode==='simulation'?'模拟模式':'真实设备'}</span><span className="subtle-note">USB {state?.usb_port??'—'}</span>
        {!state?.connected&&<button className="button" disabled={!auth||!connected||busy} onClick={()=>void run(()=>request('/connect',{}),'LBTEK 已连接')}>连接 LBTEK</button>}
        <button className="button button--quiet" disabled={!auth||!connected||!fresh||!state?.connected||busy||stopping||state.uncertain||!!state.motion_pending.length} onClick={()=>void run(()=>request('/rocker',{enabled:!state?.rocker_enabled}),state?.rocker_enabled?'摇杆控制已关闭':'摇杆控制已开启')}>{state?.rocker_enabled?'关闭摇杆控制':'开启摇杆控制'}</button>
        <button className="button stage-stop" disabled={!auth||!connected||stopping} onClick={()=>void stop()}><Square size={16}/>{stopping?'正在停止…':state?.uncertain?'全部停止并恢复':'全部停止'}</button>
      </div>}
      {error&&<p className="inline-error" role="alert">{error}</p>}{message&&<p className="hardware-message" role="status">{message}</p>}
    </section>
    {!configuration&&<>
      <div className="lbtek-axis-grid">{[1,2,3].map(channel=>{
        const row=state?.channels.find(r=>r.channel===channel)
        const reason=baseReason||(!row?'通道状态尚未读取':state?.motion_pending.includes(channel)||!row.can_run||!row.stopped?'运动中 / 等待空闲确认':'')
        return <AxisCard key={`${state?.config.mode}-${state?.usb_port}-${state?.config.units[channel-1]}-${channel}`} channel={channel} config={state?.config} row={row} reason={reason} onAction={action} onStop={()=>void stop(channel)} stopDisabled={!auth||!connected||stopping} onParameters={(speed,acceleration)=>run(()=>request('/parameters',{channel,speed,acceleration}),'参数已设置并读回')} holdingDirection={holding?.channel===channel?holding.direction:undefined} onBegin={beginHold} onEnd={endHold} onCancel={release}/>
      })}</div>
      <section className="content-panel glass-panel"><div className="panel-heading"><h2>最近运动请求</h2><HelpTooltip label="LBTEK 运动记录">最近 20 条本次运行内的请求。已下发不代表机械运动完成；完整审计记录保存在事件日志。开环坐标来自控制器计数，不是编码器实测位置。</HelpTooltip></div>
        <div className="lbtek-records">{state?.records?.length?<table><thead><tr><th>时间</th><th>通道</th><th>动作</th><th>数值</th><th>模式 / 结果</th></tr></thead><tbody>{state.records.map((r,i)=><tr key={`${r.timestamp}-${i}`}><td>{new Date(r.timestamp).toLocaleTimeString('zh-CN',{hour12:false})}</td><td>CH{r.channel}</td><td>{labels[r.operation]??r.operation}</td><td>{r.value===null?'—':number(r.value)}</td><td>{r.mode==='simulation'?'模拟 · ':''}{results[r.result]??r.result}{r.reason&&<p className="inline-error">{r.reason}</p>}</td></tr>)}</tbody></table>:<p className="subtle-note">暂无运动请求</p>}</div>
      </section>
    </>}
  </div>
}

function AxisCard({channel,config,row,reason,onAction,onStop,stopDisabled,onParameters,holdingDirection,onBegin,onEnd,onCancel}:{channel:number;config?:LbtekConfig;row?:LbtekChannel;reason:string;onAction:(channel:number,operation:string,value?:number)=>Promise<void>;onStop:()=>void;stopDisabled:boolean;onParameters:(speed:number,acceleration:number)=>Promise<boolean>;holdingDirection?:number;onBegin:(channel:number,direction:number)=>void;onEnd:(channel:number,direction:number,step:number)=>void;onCancel:()=>void}){
  const unit=config?.units[channel-1]??'mm'
  const storage=`lbtek-step:${config?.mode}:${config?.usb_port??'auto'}:${channel}:${unit}`
  const [step,setStep]=useState(()=>{try{return localStorage.getItem(storage)??'0.01'}catch{return '0.01'}})
  const [presets,setPresets]=useState<string[]>(()=>{try{const p=JSON.parse(localStorage.getItem(`${storage}:presets`)??'null');if(Array.isArray(p)&&p.length===4&&p.every(v=>typeof v==='string'))return p}catch{}return ['0.001','0.01','0.1','1']})
  const [target,setTarget]=useState('0')
  const [parameterDraft,setParameterDraft]=useState<{speed:string;acceleration:string}|null>(null)
  const speed=parameterDraft?.speed??String(row?.speed??''), acceleration=parameterDraft?.acceleration??String(row?.acceleration??'')
  useEffect(()=>{try{localStorage.setItem(storage,step);localStorage.setItem(`${storage}:presets`,JSON.stringify(presets))}catch{}},[storage,step,presets])
  const n=Number(step), max=config?.max_distance??10
  const stepError=!step.trim()||!Number.isFinite(n)||n<=0?'输入大于零的位移量':n>max?`单次位移上限 ${max} ${unit}`:''
  const limitConflict=!!row?.limit_left&&!!row?.limit_right
  const motionReason=limitConflict?'正负限位同时触发，请检查位移台连接与型号配置':row&&(row.speed<=0||row.acceleration<=0)?'速度或加速度未设置，请先应用有效参数':''
  const paramError=!speed.trim()||!acceleration.trim()||!Number.isFinite(Number(speed))||!Number.isFinite(Number(acceleration))||Number(speed)<=0||Number(speed)>1000||Number(acceleration)<=0||Number(acceleration)>10000
  const targetError=!target.trim()||!Number.isFinite(Number(target))||row&&Math.abs(Number(target)-row.position)>max
  return <section className="glass-panel lbtek-axis" aria-label={`LBTEK CH${channel} 控制`}>
    <div className="lbtek-axis-heading"><div><strong>CH{channel}</strong>{config?.names[channel-1]&&<h3>{config.names[channel-1]}</h3>}</div><span className="subtle-note">{row?row.stopped?'静止':'运动中':'未读取'}</span></div>
    <div className="lbtek-position"><span>开环坐标 <HelpTooltip label={`CH${channel} 开环坐标`}>控制器计算的位置，不能代表编码器实测位移。Home 使用该通道实际原点传感器回零；连接不执行 Home。</HelpTooltip></span><b>{number(row?.position)} <small>{unit}</small></b></div>
    <div className="lbtek-indicators"><span>{!row?'原点待读取':!row.home_sensor?'原点传感器不可用':row.home?'在原点':'未在原点'}</span><span className={row?.limit_left?'lbtek-warning':''}>负限位{!row?'待读取':row.limit_left?'已触发':'未触发'}</span><span className={row?.limit_right?'lbtek-warning':''}>正限位{!row?'待读取':row.limit_right?'已触发':'未触发'}</span></div>
    <label className="field">CH{channel} 单次位移（{unit}）<input aria-label={`CH${channel} 单次位移（${unit}）`} inputMode="decimal" type="number" step="any" min="0" max={max} value={step} onChange={e=>setStep(e.target.value)}/></label>
    <div className="lbtek-presets">{presets.map((p,i)=><button key={i} className={`button button--quiet ${step===p?'lbtek-selected':''}`} disabled={!p.trim()||!Number.isFinite(Number(p))||Number(p)<=0||Number(p)>max} onClick={()=>setStep(p)}>{p}</button>)}</div>
    <span className="lbtek-gesture-label">点按 / 按住 <HelpTooltip label={`CH${channel} 点按与按住`}>点按移动一次，按住超过 180ms 连续移动，松开停止。单次位移上限只限制点按和绝对定位，不限制按住运行的总行程。</HelpTooltip></span>
    <div className="lbtek-directions">{([-1,1] as const).map(dir=><button key={dir} className="button button--primary" aria-label={`CH${channel} ${dir<0?'负':'正'}向移动`} disabled={holdingDirection!==dir&&(!!reason||!!stepError||!!motionReason||(dir<0?row?.limit_left:row?.limit_right))}
      onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture?.(e.pointerId);onBegin(channel,dir)}}
      onPointerUp={()=>onEnd(channel,dir,n)} onPointerCancel={onCancel} onLostPointerCapture={onCancel} onBlur={onCancel}
      onClick={e=>{if(e.detail===0)void onAction(channel,'relative',dir*n)}}>{dir<0?<ArrowLeft size={20}/>:<ArrowRight size={20}/>} {dir<0?'−':'＋'}</button>)}</div>
    {(reason||stepError||motionReason)&&<p className="lbtek-reason" role="status">{reason||stepError||motionReason}</p>}
    <div className="lbtek-parameters"><label className="field">速度（{unit}/s）<input aria-label={`CH${channel} 速度`} type="number" step="any" value={speed} onChange={e=>{setParameterDraft({speed:e.target.value,acceleration})}}/></label><label className="field">加速度（{unit}/s²）<input aria-label={`CH${channel} 加速度`} type="number" step="any" value={acceleration} onChange={e=>{setParameterDraft({speed,acceleration:e.target.value})}}/></label></div>
    <div className="hardware-actions"><button className="button button--quiet" disabled={!!reason||paramError||!parameterDraft} onClick={()=>{const submitted=parameterDraft;void onParameters(Number(speed),Number(acceleration)).then(ok=>{if(ok)setParameterDraft(current=>current===submitted?null:current)})}}>应用 CH{channel} 参数</button><button className="button button--quiet" disabled={!!reason||limitConflict||!row?.home_sensor} onClick={()=>void onAction(channel,'home')}><Home size={15}/>CH{channel} 回零</button><button className="button stage-stop" disabled={stopDisabled} onClick={onStop}><Square size={15}/>停止</button></div>
    {!row?.home_sensor&&row&&<p className="lbtek-reason">未报告可用的原点传感器，回零不可用</p>}
    <Disclosure title="绝对定位与快捷位移"><label className="field">CH{channel} 目标坐标（{unit}）<input type="number" step="any" value={target} onChange={e=>setTarget(e.target.value)}/></label><button className="button" disabled={!!reason||!!motionReason||!!targetError} onClick={()=>void onAction(channel,'absolute',Number(target))}>移动到目标</button><div className="lbtek-preset-editor">{presets.map((p,i)=><label className="field" key={i}>快捷 {i+1}<input aria-label={`CH${channel} 快捷 ${i+1}`} type="number" min="0" max={max} step="any" value={p} onChange={e=>setPresets(prior=>prior.map((v,j)=>j===i?e.target.value:v))}/></label>)}</div>{targetError&&<p className="lbtek-reason">请输入有效坐标，且与当前位置距离不超过 {max} {unit}</p>}</Disclosure>
  </section>
}
