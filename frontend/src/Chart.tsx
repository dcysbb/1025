import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Activity, ChevronLeft, ChevronRight, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import { domain, nearestPoint, reducePoints, timeRange, type Point } from './chartData'
import { axisTime, linearExponent, linearTicks, logTicks, scientificParts, timeTicks } from './chartAxes'

type Unit = 'Pa' | 'mbar' | 'Torr'
type Marker = {id:number; timestamp:string; severity:string; type:string; message:string}
const FACTOR = {Pa:1, mbar:100, Torr:133.32236842105263}
const COLORS = Array.from({length:6},(_,i)=>`var(--chart-${i+1})`)
const date = (ms:number) => new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false}).format(new Date(ms))
const format = (value:number) => value.toExponential(2)

export default function Chart({points,channels,unit,compact=false,events=[]}:{points:Point[]; channels:number[]; unit:Unit; compact?:boolean; events?:Marker[]}) {
  const [view,setView] = useState<[number,number]|null>(null)
  const [scale,setScale] = useState<'log'|'linear'>('log')
  const [manual,setManual] = useState<[number,number]|null>(null)
  const [lowerDraft,setLowerDraft] = useState({unit,value:''}), [upperDraft,setUpperDraft] = useState({unit,value:''}), [error,setError] = useState('')
  const lower=lowerDraft.unit===unit?lowerDraft.value:manual?format(manual[0]/FACTOR[unit]):''
  const upper=upperDraft.unit===unit?upperDraft.value:manual?format(manual[1]/FACTOR[unit]):''
  const setLower=(value:string)=>setLowerDraft({unit,value}), setUpper=(value:string)=>setUpperDraft({unit,value})
  const [showEvents,setShowEvents] = useState(false)
  const [hover,setHover] = useState<Point|null>(null)
  const drag = useRef<{x:number;from:number;to:number}|null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const plot = useRef<HTMLDivElement>(null)
  const [width,setWidth] = useState(980)
  useEffect(()=>{
    if(typeof ResizeObserver==='undefined'||!plot.current)return
    const observer=new ResizeObserver(([entry])=>{if(entry.contentRect.width>0)setWidth(Math.round(entry.contentRect.width))})
    observer.observe(plot.current)
    return()=>observer.disconnect()
  },[])
  const clip = useId()
  const times = useMemo(()=>points.map(p=>Date.parse(p.timestamp)),[points])
  const begin = times[0]??0, finish = times.at(-1)??1
  const [from,to] = timeRange(view??[begin,finish],begin,finish)
  const visible = useMemo(()=>points.filter((_,i)=>times[i]>=from&&times[i]<=to),[points,times,from,to])
  const shown = useMemo(()=>reducePoints(visible),[visible])
  const auto = useMemo<[number,number]>(()=>{
    if(scale==='log'){const [lo,hi]=domain(visible,channels,FACTOR[unit]);return [10**lo*FACTOR[unit],10**hi*FACTOR[unit]]}
    let low=Infinity, high=-Infinity
    for(const point of visible)for(const s of point.channels)if(channels.includes(s.channel)&&s.valid&&s.pressure_pa!=null&&Number.isFinite(s.pressure_pa)&&s.pressure_pa>=0){low=Math.min(low,s.pressure_pa);high=Math.max(high,s.pressure_pa)}
    if(!Number.isFinite(low))return [0,1]
    const pad=Math.max((high-low)*.08,high*.05,1e-15)
    return [Math.max(0,low-pad),high+pad]
  },[visible,channels,scale,unit])
  const [min,max] = manual??auto
  const transform = (n:number) => scale==='log'?Math.log10(n):n
  const displayMin=min/FACTOR[unit], displayMax=max/FACTOR[unit]
  const ticks = scale==='log'?logTicks(displayMin,displayMax,compact?5:7):linearTicks(displayMin,displayMax,6)
  const exponent=scale==='linear'?linearExponent(displayMin,displayMax):0
  const linearLabel=(value:number)=>Number((value/10**exponent).toPrecision(10)).toString()
  const labelWidth=Math.max(0,...ticks.map(value=>{
    if(scale==='linear')return linearLabel(value).length*7.2
    const parts=scientificParts(value)
    return (parts.coefficient==='1'?2:parts.coefficient.length+3)*7.2+String(parts.exponent).length*5.4
  }))
  // SVG coordinates follow CSS pixels, keeping type and line weights stable at every width.
  const w=Math.max(280,width), h=compact?230:340, p={l:Math.max(w<520?66:86,Math.ceil(labelWidth+24)),r:22,t:38,b:58}, cw=w-p.l-p.r, ch=h-p.t-p.b
  const x = (stamp:string) => p.l+(Date.parse(stamp)-from)/Math.max(1,to-from)*cw
  const y = (value:number) => p.t+(1-(transform(value)-transform(min))/(transform(max)-transform(min)))*ch
  const paths = channels.map(n=>{
    let active=false
    return shown.map(point=>{
      const s=point.channels.find(s=>s.channel===n)
      if(!s?.valid||s.pressure_pa==null||!Number.isFinite(s.pressure_pa)||(scale==='log'?s.pressure_pa<=0:s.pressure_pa<0)){active=false;return ''}
      const command=`${active?'L':'M'}${x(point.timestamp).toFixed(2)} ${y(s.pressure_pa).toFixed(2)}`
      active=true;return command
    }).join(' ')
  })
  const clockTicks=timeTicks(from,to,cw)
  const zoom = (factor:number,anchor=(from+to)/2) => {
    const ratio=(anchor-from)/Math.max(1,to-from), span=Math.max(1,(to-from)*factor)
    setView(timeRange([anchor-span*ratio,anchor+span*(1-ratio)],begin,finish));setHover(null)
  }
  const pan = (direction:number) => {const span=to-from;setView(timeRange([from+span*.4*direction,to+span*.4*direction],begin,finish));setHover(null)}
  const position = useCallback((clientX:number,element:SVGSVGElement) => (clientX-element.getBoundingClientRect().left)/Math.max(1,element.getBoundingClientRect().width)*w,[w])
  useEffect(()=>{
    const element=svg.current
    if(!element||compact)return
    const wheel=(e:WheelEvent)=>{
      const px=position(e.clientX,element)
      if(px<p.l||px>w-p.r||!points.length)return
      e.preventDefault()
      const anchor=from+(px-p.l)/cw*(to-from)
      const span=Math.max(1,(to-from)*(e.deltaY>0?1.3:1/1.3)), ratio=(anchor-from)/Math.max(1,to-from)
      setView(timeRange([anchor-span*ratio,anchor+span*(1-ratio)],begin,finish));setHover(null)
    }
    element.addEventListener('wheel',wheel,{passive:false})
    return ()=>element.removeEventListener('wheel',wheel)
  },[compact,points.length,from,to,begin,finish,cw,p.l,p.r,position,w])
  function applyAxis(e:FormEvent){
    e.preventDefault()
    const lo=(lower.trim()?Number(lower):auto[0]/FACTOR[unit])*FACTOR[unit]
    const hi=(upper.trim()?Number(upper):auto[1]/FACTOR[unit])*FACTOR[unit]
    if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo<0||(scale==='log'&&lo<=0)||hi<=lo){setError(scale==='log'?'纵轴必须为正数，且上限大于下限':'上限必须大于下限，下限不能为负数');return}
    setManual([lo,hi]);setError('')
  }
  const hoveredX=hover?x(hover.timestamp):0
  return <div className={`chart-wrap ${compact?'chart-wrap--compact':''}`}>
    {!compact&&<div className="chart-toolbar">
      <div className="chart-controls" aria-label="曲线缩放">
        <div className="chart-button-group"><button disabled={!points.length} onClick={()=>zoom(.5)}><ZoomIn size={14}/>放大</button><button disabled={!points.length} onClick={()=>zoom(2)}><ZoomOut size={14}/>缩小</button>
        <button disabled={!view} onClick={()=>pan(-1)}><ChevronLeft size={14}/>向前</button><button disabled={!view} onClick={()=>pan(1)}><ChevronRight size={14}/>向后</button>
        <button onClick={()=>{setView(null);setHover(null)}}><RotateCcw size={13}/>完整范围</button></div><label className="chart-event-toggle"><input type="checkbox" checked={showEvents} onChange={e=>setShowEvents(e.target.checked)}/>显示事件</label><small>滚轮缩放 · 拖动平移</small>
      </div>
      <form className="chart-axis-controls" onSubmit={applyAxis}>
        <label>纵轴<select aria-label="纵轴刻度" value={scale} onChange={e=>{setScale(e.target.value as 'log'|'linear');setManual(null);setLower('');setUpper('');setError('')}}><option value="log">对数</option><option value="linear">线性</option></select></label>
        <label>下限 ({unit})<input aria-label="纵轴下限" value={lower} placeholder={format(auto[0]/FACTOR[unit])} onChange={e=>setLower(e.target.value)} inputMode="decimal"/></label>
        <label>上限 ({unit})<input aria-label="纵轴上限" value={upper} placeholder={format(auto[1]/FACTOR[unit])} onChange={e=>setUpper(e.target.value)} inputMode="decimal"/></label>
        <button type="submit">应用</button><button type="button" aria-pressed={!manual} onClick={()=>{setManual(null);setLower('');setUpper('');setError('')}}>自动纵轴</button>
        {error&&<span className="chart-axis-error" role="alert">{error}</span>}
      </form>
    </div>}
    <div className="chart-plot" ref={plot}>
      <svg ref={svg} className="trend-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="真空压力历史曲线" data-y-min={min} data-y-max={max}
        onPointerDown={e=>{if(compact||!points.length||e.button!==0)return;drag.current={x:e.clientX,from,to};e.currentTarget.setPointerCapture?.(e.pointerId)}}
        onPointerUp={e=>{drag.current=null;e.currentTarget.releasePointerCapture?.(e.pointerId)}} onPointerCancel={()=>{drag.current=null}}
        onPointerMove={e=>{
          if(drag.current){const delta=(e.clientX-drag.current.x)/Math.max(1,e.currentTarget.getBoundingClientRect().width)*w/cw*(drag.current.to-drag.current.from);setView(timeRange([drag.current.from-delta,drag.current.to-delta],begin,finish));setHover(null);return}
          const px=position(e.clientX,e.currentTarget)
          setHover(px<p.l||px>w-p.r?null:nearestPoint(points,times,from+(px-p.l)/cw*(to-from),from,to))
        }} onPointerLeave={()=>setHover(null)}>
        <defs><clipPath id={clip}><rect x={p.l} y={p.t} width={cw} height={ch}/></clipPath></defs>
        <text className="chart-axis-title" x={p.l} y={17}>压力 ({unit}){exponent!==0&&<> · ×10<tspan baselineShift="super" fontSize="9">{exponent}</tspan></>}</text>
        <text className="chart-axis-caption" x={w-p.r} y={17} textAnchor="end">{scale==='log'?'对数刻度':'线性刻度'}</text>
        <rect className="chart-plot-surface" x={p.l} y={p.t} width={cw} height={ch}/>
        {ticks.map((displayed,i)=>{
          const value=displayed*FACTOR[unit], parts=scientificParts(displayed)
          return <g key={i} data-y-tick={displayed}><line className="chart-gridline" x1={p.l} x2={w-p.r} y1={y(value)} y2={y(value)}/><text className="chart-axis chart-axis--y" x={p.l-12} y={y(value)} dy=".35em" textAnchor="end">{scale==='log'?<>{parts.coefficient!=='1'&&`${parts.coefficient}×`}10<tspan baselineShift="super" fontSize="9">{parts.exponent}</tspan></>:linearLabel(displayed)}</text></g>
        })}
        {points.length>0&&clockTicks.map(stamp=>{const [clock,day]=axisTime(stamp,to-from);const px=x(new Date(stamp).toISOString()), anchor=px>w-54?'end':px<p.l+25?'start':'middle';return <g key={stamp} data-time-tick={stamp}><line className="chart-gridline chart-gridline--vertical" x1={px} x2={px} y1={p.t} y2={p.t+ch}/><text className="chart-axis chart-axis--time" x={px} y={h-p.b+21} textAnchor={anchor}>{clock}</text>{day&&<text className="chart-axis chart-axis--date" x={px} y={h-p.b+38} textAnchor={anchor}>{day}</text>}</g>})}
        <g clipPath={`url(#${clip})`}>
          {channels.map((n,i)=><path key={n} d={paths[i]} fill="none" stroke={COLORS[n-1]} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>)}
          {showEvents&&events.filter(e=>Date.parse(e.timestamp)>=from&&Date.parse(e.timestamp)<=to&&(e.severity==='critical'||e.type==='valve_arrived')).map(e=><g key={e.id} data-event-marker><title>{date(Date.parse(e.timestamp))} · {e.message}</title><line x1={x(e.timestamp)} x2={x(e.timestamp)} y1={p.t} y2={p.t+ch} stroke="var(--red)" strokeDasharray="4 5" opacity=".55"/><circle cx={x(e.timestamp)} cy={p.t+4} r="4" fill="var(--red)"/></g>)}
          {hover&&<g><line className="chart-crosshair" x1={hoveredX} x2={hoveredX} y1={p.t} y2={p.t+ch}/>{hover.channels.filter(s=>channels.includes(s.channel)&&s.valid&&s.pressure_pa!=null&&Number.isFinite(s.pressure_pa)&&s.pressure_pa>=min&&s.pressure_pa<=max).map(s=><circle key={s.channel} cx={hoveredX} cy={y(s.pressure_pa!)} r="4" fill={COLORS[s.channel-1]}/>)}</g>}
        </g>
      </svg>
      {hover&&<div className="chart-tooltip" role="tooltip" style={{left:`${Math.min(76,Math.max(2,hoveredX/w*100))}%`}}><b>{date(Date.parse(hover.timestamp))}</b>{channels.map(n=>{const s=hover.channels.find(s=>s.channel===n);return <span key={n}><i style={{background:COLORS[n-1]}}/>CH{n}<strong>{s?.valid&&s.pressure_pa!=null&&Number.isFinite(s.pressure_pa)?`${format(s.pressure_pa/FACTOR[unit])} ${unit}`:'无有效数据'}</strong></span>})}</div>}
      {!points.length&&<div className="chart-empty"><Activity size={18}/>时间范围内没有采样</div>}
    </div>
    <div className="chart-footer"><div className="chart-legend">{channels.map(n=><span key={n}><i style={{background:COLORS[n-1]}}/>CH{n}</span>)}</div><span className="chart-timezone">北京时间</span></div>
  </div>
}
