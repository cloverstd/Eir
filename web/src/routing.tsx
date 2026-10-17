import {createContext,useContext,useEffect,useRef} from "react";
import type {ReactNode,Dispatch,SetStateAction} from "react";
import {useLocation,useNavigate} from "react-router";
import {normalizeSearch} from "./routingDomain";

type Navigation={set:(key:string,value:string,reset:string[])=>void;go:(path:string,keepSearch?:boolean)=>void};
const Context=createContext<Navigation|null>(null);
export function RoutingProvider({children}:{children:ReactNode}) {
  const location=useLocation(),navigate=useNavigate();
  const draft=useRef({path:location.pathname,search:normalizeSearch(location.search)});
  const locationKey=useRef(location.key),pending=useRef(false);
  if(locationKey.current!==location.key){locationKey.current=location.key;draft.current={path:location.pathname,search:normalizeSearch(location.search)}}
  const schedule=()=>{
    if(pending.current)return;
    pending.current=true;
    queueMicrotask(()=>{pending.current=false;const d=draft.current;navigate({pathname:d.path,search:d.search?"?"+d.search:""})});
  };
  useEffect(()=>{
    const canonical=normalizeSearch(location.search);
    const member=location.pathname.match(/^\/members\/([^/]+)\/?$/);
    if((location.search.replace(/^\?/,"")!==canonical)||member) navigate({pathname:member?`/members/${member[1]}/basic`:location.pathname,search:canonical?"?"+canonical:""},{replace:true});
  },[location.pathname,location.search,navigate]);
  const value:Navigation={
    set(key,value,reset){const q=new URLSearchParams(draft.current.search);for(const p of reset)q.delete(p);if(value==="")q.delete(key);else q.set(key,value);draft.current.search=q.toString();schedule()},
    go(path,keepSearch=false){draft.current.path=path;if(!keepSearch)draft.current.search="";schedule()}
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useRouteNavigation(){return useContext(Context)!}
export function useQueryState(key:string,fallback:string,reset?:string[]):[string,Dispatch<SetStateAction<string>>];
export function useQueryState(key:string,fallback:number,reset?:string[]):[number,Dispatch<SetStateAction<number>>];
export function useQueryState(key:string,fallback:boolean,reset?:string[]):[boolean,Dispatch<SetStateAction<boolean>>];
export function useQueryState<T extends string|number|boolean>(key:string,fallback:T,reset:string[]=[]):[T,Dispatch<SetStateAction<T>>] {
  const location=useLocation(),nav=useRouteNavigation();
  const raw=new URLSearchParams(normalizeSearch(location.search)).get(key);
  const value=(raw===null?fallback:typeof fallback==="number"?Number(raw):typeof fallback==="boolean"?raw==="true":raw) as T;
  return [value,(next)=>{const v=typeof next==="function"?(next as (old:T)=>T)(value):next;nav.set(key,v===fallback?"":String(v),reset)}];
}
