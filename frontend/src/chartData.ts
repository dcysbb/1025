export type Point = {timestamp:string;channels:Array<{channel:number;pressure_pa:number|null;valid:boolean;mode?:'simulation'|'real'}>}

// Each bucket retains every channel's extrema and both ends, in time order.
export function reducePoints(points:Point[], budget=1800):Point[]{
  if(points.length<=budget)return points
  const bucketSize=Math.ceil(points.length/Math.max(1,Math.floor(budget/14)))
  const keep=new Set<number>([0,points.length-1])
  for(let begin=0;begin<points.length;begin+=bucketSize){
    const end=Math.min(points.length,begin+bucketSize)
    keep.add(begin);keep.add(end-1)
    for(let channel=1;channel<=6;channel++){
      let lo=Infinity,hi=-Infinity,li=-1,hiIndex=-1
      for(let i=begin;i<end;i++){
        const sample=points[i].channels.find(x=>x.channel===channel)
        if(!sample?.valid||sample.pressure_pa==null){
          // Preserve gaps instead of connecting a trace across invalid readings.
          if(i===begin||points[i-1].channels.find(x=>x.channel===channel)?.valid)keep.add(i)
          continue
        }
        if(sample.pressure_pa<lo){lo=sample.pressure_pa;li=i}
        if(sample.pressure_pa>hi){hi=sample.pressure_pa;hiIndex=i}
      }
      if(li>=0)keep.add(li)
      if(hiIndex>=0)keep.add(hiIndex)
    }
  }
  return [...keep].sort((a,b)=>a-b).map(i=>points[i])
}

export function domain(points:Point[],channels:number[],factor=1):[number,number]{
  let low=Infinity,high=-Infinity
  for(const point of points)for(const sample of point.channels){
    if(channels.includes(sample.channel)&&sample.valid&&sample.pressure_pa!=null&&Number.isFinite(sample.pressure_pa)&&sample.pressure_pa>0){
      const value=Math.log10(sample.pressure_pa/factor);low=Math.min(low,value);high=Math.max(high,value)
    }
  }
  const min=Number.isFinite(low)?Math.floor(low):-8
  return[min,Math.max(min+1,Number.isFinite(high)?Math.ceil(high):-2)]
}

export function timeRange(view:[number,number],begin:number,finish:number):[number,number]{
  const span=Math.min(Math.max(1,view[1]-view[0]),Math.max(1,finish-begin))
  const from=Math.max(begin,Math.min(view[0],finish-span))
  return [from,Math.max(from+1,Math.min(finish,from+span))]
}

// Search the original samples, so hover never substitutes a downsampled value.
export function nearestPoint(points:Point[],times:number[],target:number,from:number,to:number):Point|null{
  let lo=0,hi=times.length
  while(lo<hi){const mid=(lo+hi)>>>1;if(times[mid]<target)lo=mid+1;else hi=mid}
  const candidates=[lo-1,lo].filter(i=>i>=0&&i<points.length&&times[i]>=from&&times[i]<=to)
  candidates.sort((a,b)=>Math.abs(times[a]-target)-Math.abs(times[b]-target))
  return candidates.length?points[candidates[0]]:null
}
