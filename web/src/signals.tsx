import {createContext,useContext,useEffect,useRef,useState} from "react";
import type {ReactNode} from "react";
import {Link,useLocation} from "react-router";
import * as echarts from "echarts/core";
import {useQueryState} from "./routing";
import {signalFresh,signalLevel,signalLinkState} from "./signalDomain";
type Row=Record<string,any>;
const Context=createContext<{rows:Row[],version:number,now:number,error:string}>({rows:[],version:0,now:0,error:""});
async function read(path:string){const r=await fetch("/api/v1/"+path);if(!r.ok)throw new Error("信号数据暂时无法更新");return r.json()}
export function SignalProvider({children}:{children:ReactNode}) {
  const [rows,setRows]=useState<Row[]>([]),[version,setVersion]=useState(0),[now,setNow]=useState(Date.now()),[error,setError]=useState("");
  useEffect(()=>{
    let active=true,inflight=false,again=false;
    const update=async()=>{
      if(inflight){again=true;return};inflight=true;
      try{const rows=await read("signals/latest");if(active){setRows(rows);setVersion(v=>v+1);setError("")}}
      catch(e){if(active)setError((e as Error).message)}
      finally{inflight=false;if(again&&active){again=false;void update()}}
    };
    const stream=new EventSource("/api/v1/events/stream");
    stream.addEventListener("signals",update);
    stream.addEventListener("change",()=>{void update();window.dispatchEvent(new Event("eir-change"))});
    stream.onopen=()=>{void update()};
    void update();
    const poll=setInterval(()=>{if(stream.readyState!==EventSource.OPEN)void update()},15000);
    const clock=setInterval(()=>setNow(Date.now()),1000);
    return()=>{active=false;stream.close();clearInterval(poll);clearInterval(clock)};
  },[]);
  return <Context.Provider value={{rows,version,now,error}}>{children}</Context.Provider>;
}
const date=(s:string)=>new Date(s).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
export function SignalValue({collector,device,compact=false}:{collector?:Row,device?:Row,compact?:boolean}) {
  const {rows,now,error}=useContext(Context);
  const kind=device?"ble":"wifi";
  const row=rows.find(r=>r.collector_id===collector?.id&&r.kind===kind&&(!device||r.device_id===device.id));
  const legacy=!device&&!collector?.status?.capabilities?.signals;
  const heartbeatRSSI=collector?.status?.rssi??collector?.status?.wifi_rssi;
  const fallback=legacy&&typeof heartbeatRSSI==="number"&&heartbeatRSSI!==0?heartbeatRSSI:null;
  const rssi=row?row.rssi:fallback;
  const at=row?.sampled_at||(legacy?collector?.last_seen:null);
  const online=row?row.online&&now-Date.parse(collector?.last_seen||0)<90000:collector?.online;
  const fresh=signalFresh(at,now)&&(!row||row.fresh);
  const level=signalLevel(rssi);
  const q=new URLSearchParams({signal_collector_id:collector?.id||"",signal_kind:kind});
  if(device)q.set("signal_device_id",device.id);
  let state=!collector?"尚未关联采集端":!online?"采集端离线":!at?"尚未观测":!fresh?"最近信号，已过期":rssi==null?"信号不可用":device?signalLinkState(row?.source,!!row?.connected):"Wi-Fi 已连接";
  if(device&&at&&!fresh&&online)state+=" · 设备可能休眠";
  return <div className={"signal-value "+(compact?"compact ":"")+(!fresh||!online?"stale":"")}>
    <span className="signal-reading"><span className="signal-bars" aria-hidden="true">{[1,2,3,4].map(n=><i key={n} className={n<=level.bars?"lit":""} style={{height:4+n*3}}/>)}</span><strong>{rssi==null?"—":`${rssi} dBm`}</strong><span>{rssi==null?"":level.label}</span></span>
    {compact&&(!fresh||!online)&&<small>{state}</small>}
    {!compact&&<><small>{device?"蓝牙":"Wi-Fi"} · {state}</small><small>{at?`采样于 ${date(at)}`:"等待设备上报"}{row?` · ${{wifi:"接入点",advertisement:"广播",connection:"连接"}[row.source as string]||row.source}`:""}</small>{legacy&&<small>心跳数据 · 升级固件后支持完整信号监测</small>}{error&&<small role="status">{error}，显示上次数据</small>}{collector&&<Link to={"/devices?"+q}>查看趋势 →</Link>}</>}
  </div>;
}
export function SignalHistory({collectors,devices}:{collectors:Row[],devices:Row[]}) {
  const [collector]=useQueryState("signal_collector_id",""),[kind]=useQueryState("signal_kind",""),[device]=useQueryState("signal_device_id","");
  const [range,setRange]=useQueryState("signal_range","1h");
  const {version}=useContext(Context);
  const [rows,setRows]=useState<Row[]>([]),[error,setError]=useState("");
  const ref=useRef<HTMLDivElement>(null),sectionRef=useRef<HTMLElement>(null),location=useLocation();
  const valid=!!collectors.find(c=>c.id===collector)&&["wifi","ble"].includes(kind)&&(kind==="wifi"||!!devices.find(d=>d.id===device&&d.collector_id===collector));
  useEffect(()=>{
    if(!valid)return;let active=true;
    const q=new URLSearchParams({collector_id:collector,kind,range});if(kind==="ble")q.set("device_id",device);
    read("signals/history?"+q).then(v=>{if(active){setRows(v.items);setError("")}}).catch(e=>{if(active)setError(e.message)});
    return()=>{active=false};
  },[collector,kind,device,range,version,valid]);
  useEffect(()=>{setRows([])},[collector,kind,device,range]);
  useEffect(()=>{if(valid)sectionRef.current?.scrollIntoView({block:"start",behavior:"smooth"})},[collector,kind,device,valid]);
  useEffect(()=>{
    if(!ref.current||!valid)return;
    const chart=echarts.init(ref.current);
    chart.setOption({color:["#0c6657","#9aaf9c","#d49a65"],tooltip:{trigger:"axis"},legend:{bottom:0},grid:{left:52,right:18,top:24,bottom:70},
      xAxis:{type:"time",splitNumber:3,axisLabel:{hideOverlap:true,formatter:(n:number)=>new Date(n).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit"})+"\n"+new Date(n).toLocaleDateString("zh-CN",{timeZone:"Asia/Shanghai",month:"numeric",day:"numeric"})}},yAxis:{type:"value",name:"dBm",scale:true},
      series:[["平均","mean"],["最弱","min"],["最强","max"]].map(([name,key])=>({name,type:"line",showSymbol:false,connectNulls:false,data:rows.map(r=>[r.time,r[key]])}))});
    const observer=new ResizeObserver(()=>chart.resize());observer.observe(ref.current);return()=>{observer.disconnect();chart.dispose()};
  },[rows,valid]);
  if(!collector)return null;
  const close=new URLSearchParams(location.search);for(const k of ["signal_collector_id","signal_kind","signal_device_id","signal_range"])close.delete(k);
  return <section ref={sectionRef} className="panel signal-history"><div className="section-title"><h2>信号趋势 · {kind==="ble"?devices.find(d=>d.id===device)?.name:collectors.find(c=>c.id===collector)?.name} · {kind==="ble"?"蓝牙":"Wi-Fi"}</h2><Link to={{pathname:"/devices",search:close.toString()}}>收起</Link></div>
    {!valid?<p>信号链路未找到，请重新选择设备。</p>:<><label>时间范围<select value={range} onChange={e=>setRange(e.target.value)}>{[["15m","最近 15 分钟"],["1h","最近 1 小时"],["24h","最近 24 小时"],["7d","最近 7 天"]].map(([v,t])=><option value={v} key={v}>{t}</option>)}</select></label><p>每 5 秒采样，保留 7 天。数值越接近 0，信号越强；等级与曲线用于比较摆放位置。</p>{error&&<p role="alert">{error}</p>}{!rows.some(r=>r.count>0)&&<p>该时段暂无信号记录，等待设备广播或连接后上报。</p>}<div className="chart" ref={ref} role="img" aria-label="信号强度历史趋势，缺测区间断开"/></>}
  </section>;
}
