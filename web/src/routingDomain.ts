export const pagePaths: Record<string,string> = {overview:"/",data:"/data",body:"/body",devices:"/devices",members:"/members",firmware:"/firmware",settings:"/settings"};
export const profileSections=["basic","history","metrics","documents"];
export function routeForPath(path:string) {
  const clean=path.replace(/\/$/,"")||"/";
  const page=Object.keys(pagePaths).find(k=>pagePaths[k]===clean);
  if(page) return {page,memberId:"",section:"basic"};
  const m=clean.match(/^\/members\/([^/]+)(?:\/([^/]+))?$/);
  if(m && (!m[2]||profileSections.includes(m[2]))) return {page:"members",memberId:m[1],section:m[2]||"basic"};
  return {page:"not-found",memberId:"",section:"basic"};
}
const enums:Record<string,string[]>={period:["7","30","90","all","custom"],group:["day","week","month"],source:["manual","device"],kind:["height","weight","body_fat","waist","blood_pressure","heart_rate","blood_glucose","oxygen_saturation","temperature","bmi"],history_kind:["condition","surgery","allergy","medication","family"],signal_kind:["wifi","ble"],signal_range:["15m","1h","24h","7d"],unassigned:["true","false"]};
export function normalizeSearch(search:string) {
  const q=new URLSearchParams(search);
  for(const [k,v] of [...q]) {
    if(enums[k]&&!enums[k].includes(v)) q.delete(k);
    if(["page","stats_page","history_page","document_page"].includes(k) && (!/^\d+$/.test(v)||Number(v)<1||Number(v)>1000000)) q.delete(k);
    if(["from","to"].includes(k)&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)) q.delete(k);
    if(["member_id","device_id","signal_device_id"].includes(k)&&v&&!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v))q.delete(k);
  }
  if(q.get("from")&&q.get("to")&&q.get("to")!<q.get("from")!)q.delete("to");
  return q.toString();
}
