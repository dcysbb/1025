import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  Activity, AlertOctagon, ArrowDownToLine, Bell, Check, ChevronDown,
  Database, Gauge, History, LayoutDashboard, LockKeyhole, LogOut, Moon, Radio,
  RefreshCw, RotateCcw, Settings2, Shield, ShieldAlert, ShieldCheck, Sun,
  TerminalSquare, TriangleAlert, Workflow, X,
} from 'lucide-react'
import type { Point } from './chartData'
import Chart from './Chart'
import StagePanel from './StagePanel'
import HardwarePanel from './HardwarePanel'
import SystemMenu from './SystemMenu'
import { Disclosure, Presence, Reveal } from './Motion'
import { apiRequest, errorMessage } from './apiClient'

type Page = 'overview' | 'history' | 'control' | 'events' | 'settings' | 'debug' | 'stage' | 'hardware'
type Unit = 'Pa' | 'mbar' | 'Torr'
type Channel = { channel:number; label:string; pressure_pa:number|null; raw_value:number|null; raw_unit:string; status_code:number|null; status:string; valid:boolean; trip_pa:number|null; reset_pa:number|null }
type Status = { timestamp:string; mode:'simulation'|'real'; interlock:'disarmed'|'ready'|'armed'|'tripped'|'fault'; interlock_label:string; trip_reason:string|null; auto_reopen_pending?:boolean; recovery_remaining_s?:number|null; valve:'unknown'|'open'|'closed'|'opening'|'closing'|'fault'; valve_open_sensor:boolean; valve_closed_sensor:boolean; tpg_connected:boolean; adam_connected:boolean; sample_age_s:number|null; sample_latency_s:number|null; sample_timestamp:string|null; sample_stale:boolean; io_reconnecting:boolean; io_reconnect_attempt:number; io_manual_reset_required:boolean; io_error:string|null; unit:string; pressure_ok:boolean; fail_closed_confirmed:boolean; history_recording:boolean; history_error:string|null; channels:Channel[] }
type ChanConfig = { enabled:boolean; label:string; trip_pa:number|null; reset_pa:number|null }
type Config = {
  io_device:'dam0808d'|'adam6050'; dam_serial_port:string; dam_baudrate:number; dam_unit_id:number; mode:'simulation'|'real'; tpg_connection:'tcp'|'usb'; tpg_serial_port:string; tpg_baudrate:number; tpg_host:string; tpg_port:number; adam_host:string; adam_port:number; adam_unit_id:number
  sample_interval_s:number; stale_timeout_s:number; valve_timeout_s:number; recovery_hold_s:number; pressure_trip_latched:boolean
  history_retention_days:number|null; allow_lan:boolean; valve_closed_di:number; valve_open_di:number|null
  valve_closed_active_high:boolean; valve_open_active_high:boolean; open_output:number; valve_open_on_energized:boolean
  fail_closed_confirmed:boolean; channels:ChanConfig[]
}
type DebugState = {output_labels?:string[];output_notes?:string[];valve_output?:number;valve_open_on_energized?:boolean;mode:'real'|'simulation';outputs:boolean[];interlock:string;remaining_s:Record<string,number>}
type EventItem = { id:number; timestamp:string; type:string; severity:string; message:string; actor:string; details:Record<string,unknown> }

const API='/api'
const FACTOR:Record<Unit,number>={Pa:1,mbar:100,Torr:133.32236842105263}
const NAV:{id:Page;label:string;icon:typeof LayoutDashboard}[]=[
  {id:'overview',label:'总览',icon:LayoutDashboard},{id:'history',label:'历史数据',icon:History},
  {id:'control',label:'联锁控制',icon:Shield},{id:'stage',label:'位移台',icon:Workflow},{id:'hardware',label:'硬件连接',icon:Radio},{id:'events',label:'事件日志',icon:Bell},{id:'settings',label:'设置',icon:Settings2},{id:'debug',label:'Debug',icon:TerminalSquare},
]

function api<T>(path:string, init?:RequestInit):Promise<T>{
  return apiRequest<T>(`${API}${path}`, init)
}

function pressure(value:number|null|undefined,unit:Unit){return value==null||!Number.isFinite(value)?'—':Number((value/FACTOR[unit]).toPrecision(3)).toExponential(2)}
function time(value?:string|null,full=false){if(!value)return'—';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:full?'2-digit':undefined,hour12:false,...(full?{year:'numeric',month:'2-digit',day:'2-digit'}:{})}).format(new Date(value))}
function localValue(date:Date){return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)}

function Chip({ok,children}:{ok:boolean;children:string}){return <span className={`status-chip ${ok?'status-chip--ok':'status-chip--muted'}`}><i/>{children}</span>}
function PressureCard({channel,unit}:{channel:Channel;unit:Unit}){
  const near=channel.trip_pa!=null&&channel.pressure_pa!=null&&channel.pressure_pa/channel.trip_pa>.7
  return <article className={`pressure-card glass-panel ${!channel.valid?'pressure-card--bad':near?'pressure-card--near':''}`}>
    <div className="pressure-card__top"><span className="channel-name"><i className="channel-light"/>{channel.label||`通道 ${channel.channel}`}</span><span className={`tiny-badge ${channel.valid?'':'tiny-badge--bad'}`}>{channel.status}</span></div>
    <div className="pressure-value">{pressure(channel.pressure_pa,unit)} <small>{unit}</small></div>
    <div className="pressure-meta"><span>关阀阈值</span><strong>{channel.trip_pa==null?'监测':`${pressure(channel.trip_pa,unit)} ${unit}`}</strong></div>
    {channel.trip_pa!=null&&channel.pressure_pa!=null&&channel.valid&&<div className="threshold-rail"><i style={{width:`${Math.min(100,channel.pressure_pa/channel.trip_pa*100)}%`}}/></div>}
  </article>
}
function EventRow({item,compact=false}:{item:EventItem;compact?:boolean}){
  const critical=item.severity==='critical'||item.severity==='error'
  return <div className={`event-row ${critical?'event-row--critical':''}`}>
    <span className="event-row__time">{time(item.timestamp,!compact)}</span>
    <i className={`event-dot ${critical?'event-dot--critical':''}`}/>
    <div className="event-row__body"><b>{item.message}</b>{!compact&&<Disclosure title="详情"><small>{item.actor} · {item.type}</small><pre>{JSON.stringify(item.details,null,2)}</pre></Disclosure>}</div>
  </div>
}

function Login({kind,onDone,onClose}:{kind:'setup'|'login';onDone:()=>void;onClose:()=>void}){
  const [password,setPassword]=useState('');const [confirm,setConfirm]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false)
  async function submit(e:FormEvent){e.preventDefault();setError('');if(kind==='setup'&&password!==confirm){setError('两次输入的密码不一致');return}setBusy(true);try{await api(kind==='setup'?'/auth/setup':'/auth/login',{method:'POST',body:JSON.stringify({password})});onDone()}catch(x){setError(x instanceof Error?x.message:'无法登录')}finally{setBusy(false)}}
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={kind==='setup'?'设置操作员密码':'操作员登录'} onMouseDown={e=>e.target===e.currentTarget&&onClose()}><form className="login-card glass-panel" onSubmit={submit}><button className="icon-button modal-close" aria-label="关闭登录窗口" type="button" onClick={onClose}><X size={17}/></button><div className="brand-mark brand-mark--large"><Shield size={24}/></div><h2>{kind==='setup'?'设置操作员密码':'操作员登录'}</h2><p>{kind==='setup'?'首次设置至少 12 位密码。密码只保存在运行设备本机。':'控制与设置需要操作员登录。'}</p><label className="field">密码<input autoFocus type="password" minLength={12} maxLength={256} autoComplete={kind==='setup'?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} required/></label>{kind==='setup'&&<label className="field">再次输入<input type="password" minLength={12} value={confirm} onChange={e=>setConfirm(e.target.value)} required/></label>}{error&&<div className="inline-error"><TriangleAlert size={15}/>{error}</div>}<button className="button button--primary login-submit" disabled={busy}>{busy?'正在验证…':kind==='setup'?'保存并登录':'登录控制台'}</button></form></div>
}

function App(){
  const [systemState,setSystemState]=useState<'running'|'exit'|'restart'>('running')
  const systemStateRef=useRef(systemState)
  const changeSystemState=useCallback((next:'running'|'exit'|'restart')=>{systemStateRef.current=next;setSystemState(next);if(next!=='running')setConnected(false)},[])
  const [relayState,setRelayState]=useState<DebugState|null>(null);const [debugError,setDebugError]=useState('');const [debugAcknowledged,setDebugAcknowledged]=useState(false);const [debugDuration,setDebugDuration]=useState(10);const [debugAutoOff,setDebugAutoOff]=useState(false);const [debugBusy,setDebugBusy]=useState(false)
  const [hardwareDirty,setHardwareDirty]=useState(false)
  const settingsBaseline=useRef('')
  function acceptConfig(config:Config){settingsBaseline.current=JSON.stringify(config);setDraft(config)}
  function navigate(next:Page){if(page==='hardware'&&next!=='hardware'&&hardwareDirty&&!window.confirm('硬件配置尚未保存，是否放弃更改？'))return;setHardwareDirty(false);setPage(next)}
  const [page,setPage]=useState<Page>('overview');const [collapsed,setCollapsed]=useState(()=>localStorage.getItem('vacuum-sidebar')==='closed');const [asideOpen,setAsideOpen]=useState(()=>localStorage.getItem('vacuum-events')==='open')
  const [unit,setUnit]=useState<Unit>(()=>(['Pa','mbar','Torr'].includes(localStorage.getItem('vacuum-unit')||'')?localStorage.getItem('vacuum-unit') as Unit:'mbar'));const [theme,setTheme]=useState<'graphite'|'light'>(()=>localStorage.getItem('vacuum-theme')==='light'?'light':'graphite');const [glass,setGlass]=useState(()=>Number(localStorage.getItem('vacuum-glass')||72))
  const [connected,setConnected]=useState(false);const [historyEvents,setHistoryEvents]=useState<EventItem[]>([]);const [eventStart,setEventStart]=useState('');const [eventEnd,setEventEnd]=useState('');const [eventKind,setEventKind]=useState('');const [eventSeverity,setEventSeverity]=useState('');const [eventOffset,setEventOffset]=useState(0);const [eventMore,setEventMore]=useState(false)
  const [status,setStatus]=useState<Status|null>(null);const [events,setEvents]=useState<EventItem[]>([]);const [points,setPoints]=useState<Point[]>([]);const [hist,setHist]=useState<Point[]>([]);const [histCount,setHistCount]=useState<number|null>(null);const [histTruncated,setHistTruncated]=useState(false);const [histReady,setHistReady]=useState(false);const [histBusy,setHistBusy]=useState(false)
  const [resetHistoryOpen,setResetHistoryOpen]=useState(false);const [resetScope,setResetScope]=useState<'simulation'|'all'>('simulation');const [resettingHistory,setResettingHistory]=useState(false)
  const [start,setStart]=useState(()=>localValue(new Date(Date.now()-86400000)));const [end,setEnd]=useState(()=>localValue(new Date()));const [channels,setChannels]=useState([1,2,3,4,5,6]);
  const [draft,setDraft]=useState<Config|null>(null);const [confirm,setConfirm]=useState('');const [auth,setAuth]=useState(false);const [configured,setConfigured]=useState(true);const [local,setLocal]=useState(true);const [login,setLogin]=useState<'setup'|'login'|null>(null);const [toast,setToast]=useState('');const [toastKind,setToastKind]=useState<'success'|'error'|'info'>('success');const [busy,setBusy]=useState(false)
  const [readErrors,setReadErrors]=useState<Record<string,string>>({})
  const [actionError,setActionError]=useState('')
  const toastTimer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const notify=useCallback((message:string,kind:'success'|'error'|'info'='success')=>{
    clearTimeout(toastTimer.current);setToastKind(kind);setToast(message)
    toastTimer.current=setTimeout(()=>setToast(''),4500)
  },[])
  useEffect(()=>()=>clearTimeout(toastTimer.current),[])
  const readError=useCallback((resource:string,message:string)=>setReadErrors(prior=>({...prior,[resource]:message})),[])
  const acceptStatus=useCallback((next:Status)=>{
    if(systemStateRef.current!=='running')return
    if(!next || !Array.isArray(next.channels))throw new Error('后台返回的压力与联锁状态格式异常，请刷新页面并检查后台版本。')
    setStatus(next);setConnected(true);readError('status','')
    setPoints(prior=>{
      const stamp=next.sample_timestamp??next.timestamp
      if(next.sample_stale||!next.tpg_connected){
        if(!prior.length||prior.at(-1)?.channels.every(channel=>!channel.valid))return prior
        return [...prior,{timestamp:next.timestamp,channels:next.channels.map(channel=>({...channel,valid:false}))}].slice(-240)
      }
      if(prior.at(-1)?.timestamp===stamp)return prior
      return [...prior,{timestamp:stamp,channels:next.channels}].slice(-240)
    })
  },[readError])
  const refreshStatus=useCallback(async()=>{
    if(systemStateRef.current!=='running')return
    try{acceptStatus(await api<Status>('/status'))}
    catch(error){setConnected(false);readError('status',errorMessage(error,'读取压力与联锁状态失败'))}
  },[acceptStatus,readError])
  const refreshEvents=useCallback(async()=>{
    try{
      const q=new URLSearchParams({limit:'200',offset:String(eventOffset)})
      if(eventStart)q.set('start',new Date(eventStart).toISOString());if(eventEnd)q.set('end',new Date(eventEnd).toISOString());if(eventKind)q.set('kind',eventKind);if(eventSeverity)q.set('severity',eventSeverity)
      const result=await api<{events:EventItem[];has_more:boolean}>(`/events?${q}`)
      if(!Array.isArray(result?.events))throw new Error('读取事件日志失败：后台返回的日志格式异常，请刷新页面并检查后台版本。')
      setEvents(result.events);setEventMore(result.has_more);readError('events','')
    }catch(error){readError('events',errorMessage(error,'读取事件日志失败'))}
  },[eventStart,eventEnd,eventKind,eventSeverity,eventOffset,readError])
  const refreshAuth=useCallback(async()=>{
    try{const x=await api<{configured:boolean;authenticated:boolean;local:boolean}>('/auth/status');if(typeof x?.authenticated!=='boolean'||typeof x.local!=='boolean')throw new Error('读取操作员登录状态失败：后台返回的权限数据格式异常。');setAuth(x.authenticated);setConfigured(x.configured);setLocal(x.local);readError('auth','')}
    catch(error){readError('auth',errorMessage(error,'读取操作员登录状态失败'))}
  },[readError])
  function reportError(error:unknown,fallback:string){const message=errorMessage(error,fallback);setActionError(message);notify(message,'error')}
  useEffect(()=>{
    void refreshAuth();let statusTimer:ReturnType<typeof setTimeout>;let polling=true
    const poll=async()=>{await refreshStatus();if(polling)statusTimer=setTimeout(()=>void poll(),1000)};void poll()
    const authTimer=setInterval(()=>void refreshAuth(),10000)
    const authNeeded=()=>{if(local){void refreshAuth();return}setAuth(false);setLogin(configured?'login':null)};window.addEventListener('auth-needed',authNeeded)
    const scheme=location.protocol==='https:'?'wss:':'ws:';let socket:WebSocket|null=null;let retry=0;let cancelled=false
    const connect=()=>{if(cancelled)return;socket=new WebSocket(`${scheme}//${location.host}/ws/status`);socket.onopen=()=>{if(!cancelled)retry=0};socket.onmessage=e=>{if(cancelled)return;try{acceptStatus(JSON.parse(e.data) as Status)}catch{readError('status','实时状态数据格式异常，正在通过后台查询重新读取。')}};socket.onclose=()=>{if(cancelled)return;void refreshStatus();window.setTimeout(connect,Math.min(5000,700+retry++*500))}}

    connect();return()=>{cancelled=true;polling=false;socket?.close();clearTimeout(statusTimer);clearInterval(authTimer);window.removeEventListener('auth-needed',authNeeded)}
  },[refreshStatus,refreshAuth,configured,local,auth,acceptStatus,readError])
  useEffect(()=>{void refreshEvents();const timer=window.setInterval(()=>void refreshEvents(),7000);return()=>clearInterval(timer)},[refreshEvents])
  useEffect(()=>{document.documentElement.dataset.theme=theme;document.documentElement.style.setProperty('--glass-alpha',String(glass/1000));localStorage.setItem('vacuum-theme',theme);localStorage.setItem('vacuum-glass',String(glass))},[theme,glass])
  useEffect(()=>{localStorage.setItem('vacuum-unit',unit)},[unit])
  useEffect(()=>{localStorage.setItem('vacuum-sidebar',collapsed?'closed':'open')},[collapsed])
  useEffect(()=>{localStorage.setItem('vacuum-events',asideOpen?'open':'closed')},[asideOpen])
  useEffect(()=>{if(!login)return;const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setLogin(null)};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[login])
  useEffect(()=>{if(page==='settings')void loadConfig();if(page==='events')void refreshEvents();if(page==='history'&&!histReady)void loadHistory();void refreshAuth();/* eslint-disable-next-line react-hooks/exhaustive-deps */},[page])
  async function loadConfig(){try{const x=await api<{config:Config}>('/config');acceptConfig(x.config);readError('config','')}catch(error){readError('config',errorMessage(error,'读取控制台设置失败'))}}
  async function loadHistory(){
    if(!start||!end||!channels.length){setHist([]);setHistCount(0);setHistReady(false);notify('请选择有效时间范围和至少一个通道','info');return}
    if(new Date(end)<=new Date(start)){notify('结束时间必须晚于开始时间','info');return}
    setHistBusy(true);setHistReady(false)
    try{
      const q=new URLSearchParams({start:new Date(start).toISOString(),end:new Date(end).toISOString(),channels:channels.join(','),limit:'100000'})
      const result=await api<{rows:Array<Record<string,unknown>>;count:number;truncated:boolean}>(`/history?${q}`)
      if(!Array.isArray(result?.rows)||!Number.isFinite(result.count))throw new Error('读取压力历史数据失败：后台返回的历史记录格式异常，请刷新页面并检查后台版本。')
      const grouped=new Map<string,Point>()
      for(const row of result.rows){const key=String(row.timestamp);let point=grouped.get(key);if(!point){point={timestamp:key,channels:[]};grouped.set(key,point)}point.channels.push({channel:Number(row.channel),pressure_pa:row.pressure_pa==null?null:Number(row.pressure_pa),valid:Boolean(row.valid),mode:row.mode==='real'?'real':'simulation'})}
      setHist([...grouped.values()]);setHistCount(result.count);setHistTruncated(result.truncated);setHistReady(true);readError('history','')
      try{
        const events=await api<{events:EventItem[]}>(`/events?${new URLSearchParams({start:new Date(start).toISOString(),end:new Date(end).toISOString(),limit:'1000'})}`)
        setHistoryEvents(events.events);readError('historyEvents','')
      }catch(error){setHistoryEvents([]);readError('historyEvents',errorMessage(error,'读取历史区间事件标记失败'))}
    }catch(error){readError('history',errorMessage(error,'读取压力历史数据失败'))}
    finally{setHistBusy(false)}
  }
  async function act(path:string,success:string){setActionError('');setBusy(true);try{setStatus(await api<Status>(path,{method:'POST',body:'{}'}));await refreshEvents();notify(success)}catch(e){reportError(e,'操作失败')}finally{setBusy(false)}}
  const active=status?.channels||[]
  const patch=(key:keyof Config,value:unknown)=>setDraft(cur=>{if(!cur)return cur;if(key==='mode'&&value==='real'&&cur.mode!=='real')return{...cur,mode:'real',fail_closed_confirmed:false,channels:cur.channels.map(ch=>({...ch,enabled:false,trip_pa:null,reset_pa:null}))};return{...cur,[key]:value} as Config})
  const editChannel=(i:number,key:keyof ChanConfig,value:unknown)=>setDraft(cur=>{if(!cur)return cur;const cs=[...cur.channels];cs[i]={...cs[i],[key]:value};return{...cur,channels:cs}})
  async function saveSettings(){if(!draft||readErrors.config)return;if(draft.mode==='real'&&draft.fail_closed_confirmed&&confirm!=='现场确认'){notify('请先输入“现场确认”后保存真实硬件确认','info');return}setActionError('');setBusy(true);try{const body={...draft,fail_closed_confirmed:draft.mode==='real'&&draft.fail_closed_confirmed&&confirm==='现场确认'};const r=await api<{config:Config;restart_required:boolean}>('/config',{method:'PATCH',body:JSON.stringify({config:Object.fromEntries((['mode','channels','sample_interval_s','stale_timeout_s','valve_timeout_s','recovery_hold_s','pressure_trip_latched','history_retention_days','allow_lan','fail_closed_confirmed'] as const).map(key=>[key,body[key]]))})});acceptConfig(r.config);setConfirm('');notify(r.restart_required?'已保存。切换局域网监听需要重启后台。':'已保存，请核对联锁状态。');void refreshStatus()}catch(e){reportError(e,'保存失败')}finally{setBusy(false)}}
  async function logOut(){setActionError('');try{await api('/auth/logout',{method:'POST'});setAuth(false);notify('已退出操作员会话')}catch(e){reportError(e,'退出失败')}}
  async function connectDevices(){setActionError('');setBusy(true);try{const r=await api<{ok:boolean;tpg?:{ok:boolean;error?:string};adam?:{ok:boolean;error?:string}}>('/devices/connect',{method:'POST',body:'{}'});if(!r.ok)throw new Error(`设备连接失败：${[r.tpg?.error&&`TPG366 真空规：${r.tpg.error}`,r.adam?.error&&`I/O 控制器：${r.adam.error}`].filter(Boolean).join('；')}`);await refreshStatus();await refreshEvents();notify('设备已连接')}catch(e){reportError(e,'设备检查失败')}finally{setBusy(false)}}
  async function simPressure(high:boolean){setActionError('');try{setStatus(await api<Status>('/simulation/pressure',{method:'POST',body:JSON.stringify({channel:1,pressure_pa:high?0.02:0.001})}));notify(high?'已注入通道 1 压力超限':'通道 1 压力已恢复')}catch(e){reportError(e,'模拟操作失败')}}
  async function simFault(kind:'io'|'gauge'|'sensor'|'close'|'tpg',enabled:boolean){setActionError('');try{setStatus(await api<Status>('/simulation/fault',{method:'POST',body:JSON.stringify({kind,enabled,channel:1})}));notify(enabled?'已注入模拟故障':'模拟故障已恢复')}catch(e){reportError(e,'模拟操作失败')}}
  async function resetHistory(){
    setActionError('');setResettingHistory(true)
    try{
      const result=await api<{deleted:number}>('/history/reset',{method:'POST',body:JSON.stringify({scope:resetScope})})
      setHist([]);setHistoryEvents([]);setHistCount(0);setHistTruncated(false);setHistReady(false)
      if(resetScope==='all')setPoints([])
      setResetHistoryOpen(false)
      await loadHistory();await refreshEvents()
      notify(`已清除 ${result.deleted.toLocaleString()} 条${resetScope==='simulation'?'模拟':'压力'}记录，采集继续运行`)
    }catch(e){reportError(e,'历史重置失败')}
    finally{setResettingHistory(false)}
  }
  const refreshRelays=useCallback(async()=>{
    try{setRelayState(await api<DebugState>('/debug/relays'));setDebugError('')}
    catch(e){setRelayState(null);setDebugError(e instanceof Error?e.message:'继电器读取失败')}
  },[])
  useEffect(()=>{
    if(page!=='debug'||!auth)return
    void refreshRelays();const timer=window.setInterval(()=>void refreshRelays(),1000)
    return()=>clearInterval(timer)
  },[page,auth,refreshRelays])
  useEffect(()=>{setDebugAcknowledged(false)},[relayState?.mode,relayState?.valve_output,relayState?.valve_open_on_energized])
  function debugActionDisabled(channel:number,enabled:boolean){
    if(!connected||!auth||debugBusy||!relayState)return true
    const opening=channel===relayState.valve_output ? enabled===(relayState.valve_open_on_energized??true) : enabled
    return opening&&(!debugAcknowledged||status?.interlock!=='disarmed'||relayState.interlock!=='disarmed')
  }
  async function switchRelay(channel:number,enabled:boolean){
    if(debugActionDisabled(channel,enabled))return
    setActionError('');setDebugBusy(true)
    try{setRelayState(await api<DebugState>(`/debug/relays/${channel}`,{method:'POST',body:JSON.stringify({enabled,duration_s:debugAutoOff?debugDuration:0})}));setDebugError('');notify(`OUT${channel+1} 已${enabled?'吸合':'释放'}`)}
    catch(e){const message=e instanceof Error?e.message:'控制失败';await refreshRelays();setDebugError(message);reportError(e,'继电器控制结果未确认')}
    finally{setDebugBusy(false)}
  }
  const eventsTrigger=useRef<HTMLButtonElement>(null)
  const showRecentEvents=asideOpen&&page!=='events'
  const ioText=status?.io_manual_reset_required?'需人工复位':status?.io_reconnecting?`重连 ${status.io_reconnect_attempt||1}/3`:status?.adam_connected?'在线':'未连接'
  const valveText=({closed:'已关闭',open:'已打开',opening:'正在打开',closing:'正在关闭',fault:'反馈冲突',unknown:'未确认'} as const)[status?.valve||'unknown']
  const interlockClass=status?.interlock==='armed'?'armed':status?.interlock==='tripped'||status?.interlock==='fault'?'tripped':'idle'
  const exportUrl=()=>`${API}/history/export.csv?${new URLSearchParams({start:new Date(start).toISOString(),end:new Date(end).toISOString(),channels:channels.join(','),unit})}`

  return <div className={`app-shell ${collapsed?'app-shell--collapsed':''} ${showRecentEvents?'':'app-shell--events-closed'}`}>
    <aside className={`sidebar glass-panel ${collapsed?'sidebar--collapsed':''}`}><div className="brand-row"><div className="brand-mark"><Gauge size={20}/></div><div className="brand-copy"><b>真空联锁</b></div><button className="icon-button sidebar-toggle" aria-label={collapsed?'展开导航':'折叠导航'} aria-expanded={!collapsed} aria-controls="primary-navigation" title={collapsed?'展开导航':'折叠导航'} onClick={()=>setCollapsed(value=>!value)}><ChevronDown size={17}/><span className="sidebar-toggle-copy">收起导航</span></button></div>
      <nav id="primary-navigation" className="nav-list" aria-label="主导航">{NAV.map(({id,label,icon:Icon})=><button key={id} className={`nav-item ${page===id?'nav-item--active':''}`} aria-current={page===id?'page':undefined} onClick={()=>navigate(id)} aria-label={label} title={collapsed?label:undefined}><Icon size={18}/><span>{label}</span>{id==='events'&&events.some(e=>e.severity==='critical')&&<i className="nav-alert"/>}</button>)}</nav><div className="sidebar-spacer"/>
      {local?<div className="user-row"><span className="user-avatar">PC</span><span className="user-copy"><b>本机控制</b></span></div>:<><button className="user-row" onClick={()=>auth?void logOut():setLogin(configured?'login':local?'setup':null)} aria-label={auth?'退出操作员会话':'操作员登录'} title={collapsed?'操作员账户':undefined}><span className="user-avatar">{auth?'OP':<LockKeyhole size={16}/>}</span><span className="user-copy"><b>{auth?'操作员已登录':'操作员登录'}</b><small>{auth?'退出操作员会话':'需验证后控制'}</small></span>{auth?<LogOut size={15}/>:<ChevronDown size={15}/>}</button></>}
      <SystemMenu auth={auth} local={local} connected={connected} dirty={hardwareDirty||!!draft&&JSON.stringify(draft)!==settingsBaseline.current} onStateChange={changeSystemState}/>
    </aside>

    <main className="main-column"><header className="topbar glass-panel"><div className="page-heading"><h1>{page==='overview'?'运行总览':page==='history'?'历史数据':page==='control'?'联锁控制':page==='events'?'事件日志':page==='stage'?'位移台':page==='debug'?'继电器调试':page==='hardware'?'硬件连接':'设置'}</h1></div><div className="topbar-right"><button className="theme-toggle" aria-label={theme==='light'?'切换为深色':'切换为浅色'} title={theme==='light'?'切换为深色':'切换为浅色'} onClick={()=>setTheme(value=>value==='light'?'graphite':'light')}>{theme==='light'?<Sun size={16}/>:<Moon size={16}/>}</button>{page!=='events'&&<button ref={eventsTrigger} className="icon-button" aria-label={asideOpen?'收起事件栏':'展开事件栏'} aria-expanded={asideOpen} aria-controls="recent-events" onClick={()=>setAsideOpen(value=>!value)}><Bell size={16}/></button>}<label className="unit-select"><select aria-label="压力单位" value={unit} onChange={e=>setUnit(e.target.value as Unit)}><option>Pa</option><option>mbar</option><option>Torr</option></select></label>{status&&<span className="mode-badge" data-mode={status.mode}>{status.mode==='simulation'?'模拟模式':'真实设备'}</span>}<button className={`live-pill ${connected?'live-pill--on':''}`} onClick={()=>void refreshStatus()}><i/>{connected?'服务在线':readErrors.status?'后台断连':'正在连接'}</button></div></header>


      {systemState!=='running'&&<div className="request-notice" role="status">{systemState==='restart'?'后台正在重启，等待新进程就绪…':'退出请求已接受，后台监测已停止；可从桌面入口重新启动。'}</div>}
      {systemState==='running'&&!connected&&readErrors.status&&<div className="inline-error connection-warning" role="alert"><TriangleAlert size={17}/>{readErrors.status} {status?'显示上次状态':'设备状态尚未读取成功'}，控制已暂停。后台恢复响应后自动更新。</div>}{status&&!status.history_recording&&<div className="inline-error connection-warning" role="alert">历史记录故障：{status.history_error||'存储不可用'}</div>}
      {connected&&readErrors.events&&<div className="request-notice" role="alert"><div><b>事件日志暂不可用</b><p>{readErrors.events}</p><small>事件列表可能已过期；正在每 7 秒自动重试。此错误不代表设备离线，设备状态请看各自状态卡。</small></div><button className="button button--quiet" onClick={()=>void refreshEvents()}>重试读取日志</button></div>}
      {connected&&readErrors.auth&&<div className="request-notice" role="alert"><div><b>操作权限状态未确认</b><p>{readErrors.auth}</p></div><button className="button button--quiet" onClick={()=>void refreshAuth()}>重新检查权限</button></div>}
      {actionError&&<div className="request-notice request-notice--error" role="alert"><div><b>操作未能确认成功</b><p>{actionError}</p></div><button className="icon-button" aria-label="关闭操作错误提示" onClick={()=>setActionError('')}><X size={15}/></button></div>}
      {status?.auto_reopen_pending&&<div className="request-notice" role="status"><div><b>等待压力恢复后自动开阀</b><p>{!connected?'后台状态未更新，自动恢复状态未确认':status.recovery_remaining_s==null?'等待压力低于恢复阈值并确认阀门已关闭':`压力已恢复，稳定倒计时 ${Math.ceil(status.recovery_remaining_s)} 秒`}</p></div><button className="button button--quiet" disabled={!connected||!auth||busy} onClick={()=>void act('/valve/close','自动开阀已取消，保持关阀请求')}>取消自动开阀</button></div>}
      <div className="page-view" key={page}>
      {page==='overview'&&<div className="page-content">
        <section className={`interlock-banner glass-panel interlock-banner--${interlockClass}`}><div className="interlock-icon">{interlockClass==='armed'?<ShieldCheck size={23}/>:interlockClass==='tripped'?<ShieldAlert size={23}/>:<Shield size={23}/>}</div><div className="interlock-banner__copy"><h2>{status?.interlock_label||'正在连接控制器'}</h2>{status?.trip_reason&&<p>{status.trip_reason}</p>}</div><div className="interlock-banner__actions">
          {status?.interlock==='armed'?<><button className="button button--quiet" disabled={!connected||!auth||busy} onClick={()=>void act('/valve/close','关阀命令已发送')}>关阀</button><button className="button button--danger-soft" disabled={!connected||!auth||busy} onClick={()=>void act('/interlock/disarm','联锁已停用，阀门保持关闭')}>停用联锁</button></>:status?.interlock==='tripped'||status?.interlock==='fault'?<button className="button button--primary" disabled={!connected||busy||!auth} onClick={()=>void act('/interlock/clear-fault','故障已清除，联锁未启用')}>复位（不启用） <RotateCcw size={15}/></button>:<button className="button button--primary" disabled={!connected||busy||!auth} onClick={()=>void act('/interlock/arm','联锁已启用')}>启用联锁 <ShieldCheck size={15}/></button>}{!auth&&!local&&<button className="text-link" onClick={()=>setLogin(configured?'login':local?'setup':null)}>登录后操作</button>}</div><div className="ambient-orb"/></section>
        <section className="metric-grid">
          <article className="metric-card glass-panel"><div className="metric-card__head"><span>插板阀位置</span><Workflow size={16}/></div><strong className={`valve-readout valve-readout--${status?.valve||'unknown'}`}>{valveText}</strong></article>
          <article className="metric-card glass-panel"><div className="metric-card__head"><span>设备通信</span><Radio size={16}/></div><div className="device-state-row"><span>TPG 366</span><b>{status?.tpg_connected?'在线':'未连接'}</b></div><div className="device-state-row"><span>I/O 控制器</span><b title={status?.io_error||undefined}>{ioText}</b></div>{status?.mode==='real'&&(!status.tpg_connected||!status.adam_connected)&&<button className="button button--quiet connect-button" disabled={!connected||!auth||busy||status?.io_reconnecting||status?.io_manual_reset_required} onClick={()=>void connectDevices()}>连接设备</button>}</article>
          <article className="metric-card glass-panel"><div className="metric-card__head"><span>采样耗时</span><Activity size={16}/></div><strong title={status?.sample_timestamp?`上次采样：${time(status.sample_timestamp,true)}`:undefined}>{!connected?'后台断连':!status?.tpg_connected?'真空规离线':status.sample_stale?'数据过期':status.sample_latency_s==null?'—':<>{(status.sample_latency_s*1000).toFixed(0)} <small>ms</small></>}</strong></article>
        </section>
        <section className="section-heading"><div><h2>真空通道</h2></div><span className="section-count">{active.length} 个通道</span></section><section className="pressure-grid">{active.map(c=><PressureCard key={c.channel} channel={c} unit={unit}/>)}</section>
        <section className="content-panel glass-panel"><div className="panel-heading"><h2>实时压力</h2><button className="text-link" onClick={()=>setPage('history')}>查看历史 <ChevronDown size={14}/></button></div><Chart points={points} channels={[1,2,3,4,5,6]} unit={unit} compact/></section>
        {status?.mode==='simulation'&&<Disclosure className="sim-tools glass-panel" title="模拟故障测试"><div className="sim-tools__actions"><button className="button button--danger-soft" disabled={!connected||!auth} onClick={()=>void simPressure(true)}><TriangleAlert size={15}/>注入压力超限</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simPressure(false)}>恢复压力</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simFault('io',true)}>模拟 I/O 中断</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simFault('io',false)}>恢复 I/O</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simFault('gauge',true)}>真空规故障</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simFault('gauge',false)}>恢复真空规</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simFault('sensor',true)}>位置反馈冲突</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simFault('sensor',false)}>恢复反馈</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simFault('close',true)}>模拟关阀失败</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simFault('close',false)}>恢复阀动作</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simFault('tpg',true)}>TPG 通信中断</button><button className="button button--quiet" disabled={!connected||!auth} onClick={()=>void simFault('tpg',false)}>恢复 TPG 通信</button></div></Disclosure>}
      </div>}

      {page==='history'&&readErrors.history&&<div className="request-notice" role="alert"><div><b>压力历史读取失败</b><p>{readErrors.history}</p><small>保留上次查询结果供参考；当前查询的导出已暂停。</small></div><button className="button button--quiet" disabled={histBusy} onClick={()=>void loadHistory()}>重新查询历史</button></div>}
      {page==='history'&&histReady&&readErrors.historyEvents&&<div className="request-notice" role="alert"><div><b>历史曲线事件标记不可用</b><p>{readErrors.historyEvents}</p><small>压力曲线与 CSV 数据仍可使用。</small></div></div>}
      {page==='history'&&<div className="page-content"><section className="filter-panel glass-panel"><div className="filter-grid"><label className="field">开始时间<input type="datetime-local" value={start} onChange={e=>{setStart(e.target.value);setHistReady(false)}}/></label><label className="field">结束时间<input type="datetime-local" value={end} onChange={e=>{setEnd(e.target.value);setHistReady(false)}}/></label><div className="field channel-filter"><span className="field-label">显示通道</span><div>{[1,2,3,4,5,6].map(n=><label key={n}><input type="checkbox" checked={channels.includes(n)} onChange={e=>{setChannels(c=>e.target.checked?[...c,n].sort():c.filter(x=>x!==n));setHistReady(false)}}/>CH{n}</label>)}</div></div><div className="filter-buttons"><button className="button button--quiet" disabled={histBusy||resettingHistory} onClick={()=>void loadHistory()}><RefreshCw size={15} className={histBusy?'spin':''}/>{histBusy?'读取中':'查询数据'}</button><a className={`button button--primary ${histCount&&histReady&&channels.length?'':'is-disabled'}`} href={histCount&&histReady&&channels.length?exportUrl():undefined} onClick={e=>(!histCount||!histReady||!channels.length)&&e.preventDefault()}><ArrowDownToLine size={15}/>导出 CSV</a><button className="button button--quiet" disabled={!connected||!auth||histBusy||resettingHistory} onClick={()=>{setResetScope('simulation');setResetHistoryOpen(true)}}>重置历史</button></div></div></section>
        <section className="content-panel glass-panel history-chart-panel"><div className="panel-heading"><div><h2>历史真空曲线</h2></div><span className="history-count">{histCount==null?'选择时间范围查询':`${histCount.toLocaleString()} 条${histTruncated?' · 已达到查询上限':''}`}</span></div><Chart key={`${start}-${end}-${histCount}`} points={hist} channels={channels} unit={unit} events={historyEvents}/></section>
        <section className="content-panel glass-panel history-table-panel"><div className="panel-heading"><div><h2>采样记录</h2></div><span className="subtle-note">最近 80 个时间点 · CSV 导出全部</span></div><div className="table-scroll"><table><thead><tr><th>北京时间</th><th>通道</th><th>压力</th><th>状态</th><th>记录模式</th></tr></thead><tbody>{hist.slice(-80).reverse().flatMap(p=>p.channels.filter(c=>channels.includes(c.channel)).map(c=><tr key={`${p.timestamp}-${c.channel}`}><td>{time(p.timestamp,true)}</td><td>CH{c.channel}</td><td>{pressure(c.pressure_pa,unit)} {unit}</td><td>{c.valid?'正常':'异常'}</td><td>{c.mode==='simulation'?'模拟':'真实'}</td></tr>))}</tbody></table>{histReady&&!histCount&&<div className="empty-state"><Database size={22}/>时间范围内没有记录</div>}</div></section></div>}

      {page==='stage'&&<StagePanel auth={auth} connected={connected}/>}
      {page==='hardware'&&<HardwarePanel auth={auth} connected={connected} systemState={status} onDirtyChange={setHardwareDirty}/>}
      {page==='control'&&<div className="page-content control-page"><section className={`control-hero glass-panel interlock-banner--${interlockClass}`}><Workflow size={36}/><h2>插板阀 · {valveText}</h2><div className="control-hero__chips"><Chip ok={status?.interlock==='armed'}>{status?.interlock_label||'状态未知'}</Chip></div>{status?.trip_reason&&<p role="alert">{status.trip_reason}</p>}</section>
        <section className="control-actions glass-panel"><div className="panel-heading"><div><h2>操作</h2></div></div><div className="control-action-grid"><button className="action-tile action-tile--close" disabled={!connected||!auth||busy} onClick={()=>void act('/valve/close','关阀命令已发送')}><span><X size={19}/></span><b>关闭插板阀</b></button><button className="action-tile" disabled={!connected||!auth||busy||status?.interlock!=='armed'||status?.valve!=='closed'} onClick={()=>void act('/valve/open','开阀命令已发送')}><span><ChevronDown size={19}/></span><b>打开插板阀</b><small>需启用联锁并确认关闭到位</small></button>{status?.interlock==='armed'?<button className="action-tile action-tile--warning" disabled={!connected||!auth||busy} onClick={()=>void act('/interlock/disarm','联锁已停用，阀门保持关闭')}><span><ShieldAlert size={19}/></span><b>停用联锁</b><small>保持关阀</small></button>:status?.interlock==='tripped'||status?.interlock==='fault'?<button className="action-tile action-tile--warning" disabled={!connected||!auth||busy} onClick={()=>void act('/interlock/clear-fault','故障已清除，联锁未启用')}><span><RotateCcw size={19}/></span><b>复位（不启用）</b><small>清除故障，联锁保持停用</small></button>:<button className="action-tile action-tile--safe" disabled={!connected||!auth||busy} onClick={()=>void act('/interlock/arm','联锁已启用')}><span><ShieldCheck size={19}/></span><b>启用联锁</b><small>检查压力与关闭到位</small></button>}</div></section>
        <section className="content-panel glass-panel"><div className="panel-heading"><div><h2>保护条件</h2></div></div><div className="protective-grid"><Chip ok={status?.tpg_connected||false}>{status?.tpg_connected?'TPG 366 在线':'TPG 366 未连接'}</Chip><Chip ok={status?.adam_connected||false}>{`I/O ${ioText}`}</Chip><Chip ok={status?.pressure_ok||false}>{status?.pressure_ok?'压力条件正常':'压力条件未满足'}</Chip><Chip ok={status?.fail_closed_confirmed||false}>{status?.fail_closed_confirmed?'已确认断电关阀':'未确认断电关阀'}</Chip></div></section></div>}

      {page==='events'&&<div className="page-content"><section className="filter-panel glass-panel"><div className="settings-grid"><label className="field">日志开始时间<input type="datetime-local" value={eventStart} onChange={e=>{setEventStart(e.target.value);setEventOffset(0)}}/></label><label className="field">日志结束时间<input type="datetime-local" value={eventEnd} onChange={e=>{setEventEnd(e.target.value);setEventOffset(0)}}/></label><label className="field">事件类型<input value={eventKind} placeholder="例如 pressure_trip" onChange={e=>{setEventKind(e.target.value);setEventOffset(0)}}/></label><label className="field">级别<select value={eventSeverity} onChange={e=>{setEventSeverity(e.target.value);setEventOffset(0)}}><option value="">全部</option>{['info','warning','error','critical'].map(x=><option key={x}>{x}</option>)}</select></label></div></section><section className="content-panel glass-panel full-events"><div className="panel-heading"><div><h2>系统事件</h2></div><button className="button button--quiet" onClick={()=>void refreshEvents()}><RefreshCw size={15}/>刷新</button></div><div className="event-feed">{events.map(e=><EventRow item={e} key={e.id}/>)}</div>{!events.length&&<div className="empty-state"><Bell size={22}/>暂无事件</div>}<div className="pagination"><button className="button" disabled={!eventOffset} onClick={()=>setEventOffset(n=>Math.max(0,n-200))}>上一页</button><span>第 {Math.floor(eventOffset/200)+1} 页</span><button className="button" disabled={!eventMore} onClick={()=>setEventOffset(n=>n+200)}>下一页</button></div></section></div>}

      {page==='settings'&&readErrors.config&&<div className="request-notice" role="alert"><div><b>设置读取失败</b><p>{readErrors.config}</p><small>保存已暂停；成功重新读取设置后再保存。</small></div><button className="button button--quiet" onClick={()=>void loadConfig()}>重新读取设置</button></div>}
      {page==='settings'&&<div className="page-content settings-page">{!draft?<div className="empty-state glass-panel"><RefreshCw className="spin"/>正在读取设备设置…</div>:<>
        <section className="content-panel glass-panel"><div className="panel-heading"><div><h2>运行方式</h2></div></div><div className="mode-switch"><button className={draft.mode==='simulation'?'selected':''} onClick={()=>patch('mode','simulation')}><Activity size={18}/><b>模拟模式</b><small>不向真实硬件发送控制命令</small></button><button className={draft.mode==='real'?'selected mode-switch__real':''} onClick={()=>patch('mode','real')}><TerminalSquare size={18}/><b>真实设备</b><small>现场接线与阀位确认</small></button></div></section>
        <section className="content-panel glass-panel"><div className="panel-heading"><h2>采样与保护</h2></div><div className="settings-grid">{([['sample_interval_s','历史采样间隔（秒）',0.2,30],['stale_timeout_s','数据超时保护（秒）',0.5,10],['valve_timeout_s','阀门动作超时（秒）',0.5,20],['recovery_hold_s','压力恢复稳定时间（秒）',0,120]] as const).map(([key,label,min,max])=><label className="field" key={key}>{label}<input type="number" min={min} max={max} step="0.1" value={draft[key]} onChange={e=>patch(key,Number(e.target.value))}/></label>)}<label className="field">历史保留天数（留空不限）<input type="number" min="1" max="3650" value={draft.history_retention_days??''} onChange={e=>patch('history_retention_days',e.target.value===''?null:Number(e.target.value))}/></label></div></section>
        <section className="content-panel glass-panel"><div className="panel-heading"><div><h2>通道与压力阈值</h2></div><span className="subtle-note">达到上限触发，低于恢复值才允许复位</span></div><div className="settings-grid"><label className="field">超压恢复方式<select aria-label="超压恢复方式" value={draft.pressure_trip_latched===false?'automatic':'latched'} onChange={e=>patch('pressure_trip_latched',e.target.value==='latched')}><option value="latched">锁存，人工复位</option><option value="automatic">压力恢复后自动开阀</option></select></label></div><div className="threshold-table-wrap"><table className="threshold-table"><thead><tr><th>保护</th><th>通道</th><th>名称</th><th>关阀阈值 ({unit})</th><th>恢复阈值 ({unit})</th></tr></thead><tbody>{draft.channels.map((c,i)=><tr key={i}><td><input type="checkbox" checked={c.enabled} aria-label={`启用通道 ${i+1}`} onChange={e=>editChannel(i,'enabled',e.target.checked)}/></td><td>CH{i+1}</td><td><input className="table-input" value={c.label} maxLength={24} placeholder={`通道 ${i+1}`} onChange={e=>editChannel(i,'label',e.target.value)}/></td><td><input className="table-input" type="number" min="0" step="any" value={c.trip_pa==null?'':Number((c.trip_pa/FACTOR[unit]).toPrecision(5))} placeholder="必填" onChange={e=>editChannel(i,'trip_pa',e.target.value===''?null:Number(e.target.value)*FACTOR[unit])}/></td><td><input className="table-input" type="number" min="0" step="any" value={c.reset_pa==null?'':Number((c.reset_pa/FACTOR[unit]).toPrecision(5))} placeholder="必填" onChange={e=>editChannel(i,'reset_pa',e.target.value===''?null:Number(e.target.value)*FACTOR[unit])}/></td></tr>)}</tbody></table></div></section>
        {draft.mode==='real'&&<section className="content-panel glass-panel commissioning-panel"><div className="panel-heading"><div><h2>真实硬件启用确认</h2></div></div><div className="commissioning-note"><AlertOctagon size={20}/><p>程序或通信失效时无法保证关阀。启用前须验证断电关阀与阀位反馈。</p></div><label className="field confirm-field">现场确认口令<input value={confirm} placeholder="输入：现场确认" onChange={e=>setConfirm(e.target.value)}/></label><label className="check-row"><input type="checkbox" checked={draft.fail_closed_confirmed} onChange={e=>patch('fail_closed_confirmed',e.target.checked)}/>我已验证电磁阀断电关阀和阀位反馈</label></section>}
        <section className="content-panel glass-panel"><div className="panel-heading"><div><h2>局域网访问</h2></div></div><label className="check-row"><input type="checkbox" checked={draft.allow_lan} onChange={e=>patch('allow_lan',e.target.checked)}/>允许局域网内设备通过 HTTPS 访问控制台</label><div className="info-line"><LockKeyhole size={16}/>远程访问需要密码和可信证书；修改后须重启服务。</div></section>
        <Disclosure className="content-panel glass-panel appearance-settings" title="外观"><label className="field">玻璃强度<input type="range" min="25" max="100" value={glass} onChange={e=>setGlass(Number(e.target.value))}/></label></Disclosure>
        <div className="settings-footer"><span>保存会关阀；已启用的联锁将锁存。</span><div><button className="button button--quiet" onClick={()=>void loadConfig()}>放弃更改</button><button className="button button--primary" disabled={!connected||busy||!auth||!!readErrors.config} onClick={()=>void saveSettings()}>{busy?'保存中':'保存设置'} <Check size={15}/></button></div></div>

      </>}</div>}
      {page==='debug'&&<div className="page-content"><section className="content-panel glass-panel"><div className="panel-heading"><div><h2>DAM0808D 手动控制</h2></div><button className="button button--quiet" disabled={!auth||debugBusy} onClick={()=>void refreshRelays()}><RefreshCw size={15}/>刷新状态</button></div><p className="debug-warning">手动调试绕过压力保护，可使阀门动作；仅限停机调试。程序或通信故障时无法保证断电。</p>{!auth&&!local&&<button className="button button--primary" onClick={()=>setLogin(configured?'login':'setup')}>登录后调试</button>}<div className="settings-grid"><div className="debug-timer"><label><input type="checkbox" checked={debugAutoOff} onChange={e=>setDebugAutoOff(e.target.checked)}/>定时关闭（否则需手动关闭）</label><Reveal open={debugAutoOff}><label className="field">自动关闭时间（秒）<input disabled={!debugAutoOff} type="number" min="1" max="60" value={debugDuration} onChange={e=>setDebugDuration(Math.max(1,Math.min(60,Number(e.target.value)||1)))}/></label></Reveal></div><label><input type="checkbox" checked={debugAcknowledged} onChange={e=>setDebugAcknowledged(e.target.checked)}/>已确认设备可以动作，并已核对接线和线圈电压</label></div>{debugError&&<div className="inline-error" role="alert">{debugError}</div>}{status&&status.interlock!=='disarmed'&&<p className="inline-error">请先停用联锁，再手动请求开阀或开启普通输出。</p>}<div className="debug-relay-grid">{Array.from({length:8},(_,channel)=><article className={`glass-panel debug-relay-card ${relayState?.valve_output===channel?'debug-relay-card--valve':''}`} key={channel}><h3>OUT{channel+1} <small>DO{channel}</small></h3><div className="relay-function">{relayState?.output_labels?.[channel]}{relayState?.valve_output===channel&&<b> · 插板阀电磁阀</b>}{relayState?.output_notes?.[channel]&&<div>{relayState.output_notes[channel]}</div>}</div><p>{relayState?relayState.outputs[channel]?'已吸合':'已释放':'状态未知'}{relayState?.remaining_s[String(channel)]!=null&&` · ${Math.ceil(relayState.remaining_s[String(channel)])} 秒后关闭`}{relayState?.outputs[channel]&&relayState.remaining_s[String(channel)]==null&&" · 持续吸合"}</p><div className="filter-buttons"><button className="button button--primary" aria-label={`开启 OUT${channel+1}`} disabled={debugActionDisabled(channel,true)} onClick={()=>void switchRelay(channel,true)}>{relayState?.valve_output===channel ? `吸合（${(relayState.valve_open_on_energized??true)?'开阀':'关阀'}）` : '开启'}</button><button className="button button--quiet" aria-label={`关闭 OUT${channel+1}`} disabled={debugActionDisabled(channel,false)} onClick={()=>void switchRelay(channel,false)}>{relayState?.valve_output===channel ? `释放（${(relayState.valve_open_on_energized??true)?'关阀':'开阀'}）` : '关闭'}</button></div></article>)}</div></section></div>}

      </div>
    </main>

    <div id="recent-events" className="events-slot" data-open={showRecentEvents} aria-hidden={!showRecentEvents} inert={!showRecentEvents}><aside className="events-aside glass-panel" aria-label="最近事件"><div className="aside-heading"><h2>最近事件</h2><div><button className="icon-button" onClick={()=>void refreshEvents()} title="刷新事件" aria-label="刷新事件"><RefreshCw size={14}/></button><button className="icon-button" onClick={()=>{setAsideOpen(false);eventsTrigger.current?.focus({preventScroll:true})}} aria-label="收起事件栏" aria-expanded={showRecentEvents}><X size={15}/></button></div></div><div className="aside-events">{events.slice(0,18).map(e=><EventRow item={e} compact key={e.id}/>)}{!events.length&&<div className="event-empty">暂无事件</div>}</div><button className="text-link" onClick={()=>navigate('events')}>全部事件</button></aside></div>

    <div className="mobile-nav">{NAV.map(({id,label,icon:Icon})=><button key={id} aria-current={page===id?'page':undefined} onClick={()=>navigate(id)}><Icon size={18}/><span>{label==='联锁控制'?'控制':label==='历史数据'?'历史':label==='事件日志'?'事件':label}</span></button>)}</div>
    <Presence show={resetHistoryOpen}>{resetHistoryOpen&&<div className="modal-backdrop"><section className="login-card glass-panel" role="dialog" aria-modal="true" aria-labelledby="history-reset-title"><h2 id="history-reset-title">重置压力历史</h2><p>清除所选范围内全部压力记录，不受页面筛选限制；不可撤销。事件日志保留，采集继续。</p><label className="field">重置范围<select value={resetScope} disabled={resettingHistory} onChange={e=>setResetScope(e.target.value as 'simulation'|'all')}><option value="simulation">仅清除模拟数据（保留真实数据）</option><option value="all">清除全部压力数据（包含真实数据）</option></select></label><div className="filter-buttons"><button className="button button--quiet" disabled={resettingHistory} onClick={()=>setResetHistoryOpen(false)}>取消</button><button className="button button--primary" disabled={resettingHistory||!connected||!auth} onClick={()=>void resetHistory()}>{resettingHistory?'重置中':'确认重置'}</button></div></section></div>}</Presence>
    <Presence show={Boolean(toast)}>{toast&&<div className={`toast-message toast-message--${toastKind}`} role={toastKind==='error'?'alert':'status'}><span>{toastKind==='success'?<Check size={16}/>:<TriangleAlert size={16}/>}</span>{toast}<button aria-label="关闭消息" onClick={()=>setToast('')}><X size={15}/></button></div>}</Presence><Presence show={Boolean(login)}>{login&&<Login kind={login} onClose={()=>setLogin(null)} onDone={()=>{setAuth(true);setConfigured(true);setLogin(null);notify('操作员已登录');void refreshStatus()}}/>}</Presence>
  </div>
}

export default App
