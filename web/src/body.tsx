import {useQueryState} from "./routing";
import {useEffect, useRef, useState} from "react";
import * as echarts from "echarts/core";
import {bodyFatStatus, bodyFatValue, scaleProfile} from "./bodyDomain";
import {measurementCorrection, measurementQuery, chartDay} from "./domain";
type Row = Record<string, any>;
type Props = {members: Row[]; devices: Row[]; refresh: number; api: (path:string,method?:string,body?:unknown)=>Promise<any>; action:(fn:()=>Promise<unknown>,message?:string)=>Promise<void>; busy:boolean};
const date=(s:string)=>s ? new Date(s).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}) : "采集端未校时";
const number=(v:any)=>v==null?"—":Number(v).toFixed(2);

export function ProfileFields({member}: {member?:Row}) {
  const [month,setMonth]=useState(member?.birth_month||member?.birth_date?.slice(0,7)||"");
  const [day,setDay]=useState(member?.birth_date?.slice(0,10)||"");
  return <><label>计算用性别<select name="sex" defaultValue={member?.sex || ""}><option value="">暂不填写</option><option value="male">男</option><option value="female">女</option></select></label><label>出生年月<input type="month" name="birth_month" value={month} onChange={e=>{setMonth(e.target.value);if(day&&!day.startsWith(e.target.value))setDay("")}}/></label><label>出生日期（可选）<input type="date" name="birth_date" value={day} onChange={e=>{setDay(e.target.value);if(e.target.value)setMonth(e.target.value.slice(0,7))}}/></label><label>身高（厘米）<input type="number" min="50" max="250" step="0.1" name="height_cm" defaultValue={member?.height_cm || ""} placeholder="体脂估算需要"/></label></>;
}

function BodyChart({buckets}:{buckets:Row[]}) {
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!ref.current)return;
    const chart=echarts.init(ref.current);
    chart.setOption({color:["#0c6657","#cd925b"],tooltip:{trigger:"axis"},legend:{bottom:0},grid:{left:48,right:48,top:25,bottom:60},xAxis:{type:"category",data:buckets.map(b=>chartDay(b.time))},yAxis:[{type:"value",name:"kg",scale:true},{type:"value",name:"%",scale:true}],series:[{name:"体重",type:"line",data:buckets.map(b=>b.weight_kg),connectNulls:false},{name:"估算体脂率",type:"line",yAxisIndex:1,data:buckets.map(b=>b.body_fat_pct),connectNulls:false}]});
    const observer=new ResizeObserver(()=>chart.resize());observer.observe(ref.current);
    return ()=>{observer.disconnect();chart.dispose()};
  },[buckets]);
  return <div ref={ref} className="chart" role="img" aria-label="体重和估算体脂率趋势"/>;
}

export function BodyMeasurements({members,devices,refresh,api,action,busy}:Props) {
  const [member,setMember]=useQueryState("member_id","",["page"]),[device,setDevice]=useQueryState("device_id","",["page"]),[period,setPeriod]=useQueryState("period","30",["page"]),[from,setFrom]=useQueryState("from","",["page"]),[to,setTo]=useQueryState("to","",["page"]),[group,setGroup]=useQueryState("group","day",["page"]),[page,setPage]=useQueryState("page",1),[unassigned,setUnassigned]=useQueryState("unassigned",false,["page"]);
  const [rows,setRows]=useState<Row[]>([]),[stats,setStats]=useState<Row>({}),[total,setTotal]=useState(0),[error,setError]=useState("");
  const [editing,setEditing]=useState<Row|null>(null);
  const q=measurementQuery({member,device,period,from,to,group,page,unassigned,kind:"body_composition"});
  useEffect(()=>{
    let active=true;
    Promise.all([api("measurements?"+q),api("statistics?"+q)]).then(([data,stats])=>{if(active){setRows(data.items);setTotal(data.total);setStats(stats);setError("")}}).catch(e=>active&&setError(e.message));
    return ()=>{active=false};
  },[q,refresh,api]);
  const scales=devices.filter(d=>d.profile===scaleProfile);
  return <>
    <div className="filters"><label>家庭成员<select value={member} onChange={e=>setMember(e.target.value)}><option value="">全部成员</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>体脂秤<select value={device} onChange={e=>setDevice(e.target.value)}><option value="">全部体脂秤</option>{scales.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label><label>时间范围<select value={period} onChange={e=>setPeriod(e.target.value)}><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option><option value="all">全部时间（含未校时）</option><option value="custom">自定义</option></select></label>{period==="custom"&&<><label>开始日期<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>结束日期<input type="date" min={from} value={to} onChange={e=>setTo(e.target.value)}/></label></>}<label>汇总<select value={group} onChange={e=>setGroup(e.target.value)}><option value="day">按日</option><option value="week">按周</option><option value="month">按月</option></select></label><label className="check"><input type="checkbox" checked={unassigned} onChange={e=>{setUnassigned(e.target.checked);if(e.target.checked){setMember("");setPeriod("all")}}}/>待归属</label></div>
    {error&&<p className="alert" role="alert">{error}</p>}
    <div className="metrics">{[["称重记录",stats.count??0,"次"],["平均体重",number(stats.mean_weight_kg),"kg"],["平均估算体脂率",number(stats.mean_body_fat_pct),"%"],["有效体脂估算",stats.body_fat_count??0,"次"]].map(([title,v,unit])=><article className="metric" key={String(title)}><span>{title}</span><div>{v}<small>{unit}</small></div></article>)}</div>
    <section className="panel"><h2>体重与估算体脂率趋势</h2><p>体脂率为参考公式估算。未取得有效 ADC 或资料不完整的记录不参与体脂率统计。</p><BodyChart buckets={stats.buckets||[]}/></section>
    <section className="panel"><div className="section-title"><h2>称重记录 · {total} 条</h2><a className="button secondary" href={"/api/v1/measurements/export.csv?"+q}>导出 CSV</a></div>{!rows.length?<p>暂无称重记录。添加体脂秤并绑定成员后，唤醒体脂秤进行测量。</p>:<><div className="table-wrap"><table><thead><tr><th>采集时间</th><th>成员／体脂秤</th><th>体重</th><th>估算体脂率</th><th>操作</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td>{date(row.measured_at)}<small>收到于 {date(row.received_at)}</small></td><td>{row.member_name||"待归属"}<small>{row.device_name}</small></td><td className="bp">{number(row.weight_kg)} <small>kg</small>{row.weight_valid===false&&<small>调试读数未锁定 · 已排除统计</small>}</td><td>{bodyFatValue(row)===null?"—":number(row.body_fat_pct)+" %"}<small>{bodyFatStatus(row.body_fat_status)}</small>{row.profile_snapshot?.age_approximate&&<small>年龄按出生年月估算</small>}</td><td><button className="link" onClick={()=>setEditing(editing?.id===row.id?null:row)}>详情／编辑</button></td></tr>)}</tbody></table></div><div className="pagination"><button className="secondary" disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span>第 {page} 页</span><button className="secondary" disabled={page*50>=total} onClick={()=>setPage(page+1)}>下一页</button></div></>}</section>
    {editing&&<section className="panel"><h2>称重详情与归属</h2><p>{editing.device_name} · {date(editing.measured_at)}</p><dl><dt>原始 ADC</dt><dd>{editing.raw_adcs?.join(" / ")||"未取得"}</dd><dt>计算通道</dt><dd>ADC {editing.adc_index+1}</dd><dt>估算算法</dt><dd>{editing.algorithm_version||"未计算"}</dd><dt>计算资料快照</dt><dd>{editing.profile_snapshot?.height_cm||"—"} cm · 年龄 {editing.profile_snapshot?.age_approximate?"约 ":""}{editing.profile_snapshot?.age??"—"}</dd></dl><form className="form-grid" key={editing.id} onSubmit={e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.currentTarget));action(async()=>{await api("measurements/"+editing.id,"PATCH",measurementCorrection(editing.member_id,String(values.member_id),String(values.notes)));setEditing(null)},"归属已保存，体脂估算已按所选成员资料更新")}}><label>成员<select name="member_id" defaultValue={editing.member_id||""}><option value="">待归属</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>备注<input name="notes" defaultValue={editing.notes||""}/></label><button disabled={busy}>保存</button><button className="secondary" type="button" onClick={()=>setEditing(null)}>关闭</button></form></section>}
  </>;
}
