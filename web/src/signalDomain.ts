export function signalLevel(rssi:number|null|undefined) {
  if(rssi==null)return {label:"不可用",bars:0};
  return rssi>=-60?{label:"强",bars:4}:rssi>=-75?{label:"良好",bars:3}:rssi>=-85?{label:"较弱",bars:2}:{label:"很弱",bars:1};
}
export function signalFresh(sampledAt:string|null|undefined,now=Date.now()) {
  return !!sampledAt && now-Date.parse(sampledAt)<=15000 && now-Date.parse(sampledAt)>=-5000;
}
export function signalLinkState(source:string,connected:boolean) {
  if(connected)return "蓝牙已连接";
  return source==="connection"?"最近连接信号 · 当前未连接":"最近收到蓝牙广播";
}
