import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BusinessData, Entity, EntityKey, Receipt, StockMovement, ChatMessage } from './types';
import { api, ApiError } from './services/api';
import { createMessageId } from './lib/messageId';

export type Session = { user: {id:string;email:string;name:string}; workspace:{id:string;name:string;role:'owner'}; csrfToken:string };
export type Snapshot = {data:BusinessData;revision:number};
export type Backup = {format:'yunji-commercial-backup';version:1;exportedAt:string;data:BusinessData;revision:number};
export type AuditEvent = {id:string;action:string;entityKind:string;entityId:string;createdAt:string};
const empty = (): BusinessData => ({version:1,customers:[],orders:[],products:[],transactions:[],receipts:[],stockMovements:[]});
type Store = {
  data:BusinessData; session:Session|null; loading:boolean; ready:boolean; error:string; conflict:boolean; revision:number;
  login:(values:{email:string;password:string})=>Promise<void>;
  register:(values:{email:string;password:string;name:string;workspaceName:string;inviteCode?:string})=>Promise<void>;
  logout:()=>Promise<void>; checkSession:()=>Promise<void>; refresh:()=>Promise<void>;
  save:(key:EntityKey,value:Entity)=>Promise<void>; remove:(key:EntityKey,id:string)=>Promise<void>;
  pay:(value:Receipt)=>Promise<void>; adjustStock:(value:StockMovement)=>Promise<void>;
  exportBackup:()=>Promise<Backup>; restore:(backup:Backup)=>Promise<void>;
  changePassword:(values:{currentPassword:string;newPassword:string})=>Promise<void>;
  audit:()=>Promise<AuditEvent[]>;
  ask:(question:string,history:ChatMessage[])=>Promise<{answer:string;mode:'rules'|'llm'}>;
};
const Context = createContext<Store|null>(null);
class StaleSessionError extends Error { constructor(){super('账号会话已变化，旧请求已忽略。');} }
export function StoreProvider({children}:{children:ReactNode}) {
  const [session,setSession] = useState<Session|null>(null);
  const sessionRef = useRef<Session|null>(null);
  const sessionEpoch = useRef(0);
  const [snapshot,setSnapshot] = useState<Snapshot>({data:empty(),revision:0});
  const revision = useRef(0);
  const [loading,setLoading] = useState(true);
  const [ready,setReady] = useState(false);
  const [error,setError] = useState('');
  const [conflict,setConflict] = useState(false);
  const retries = useRef(new Map<string,{key:string;revision:number}>());
  function setIdentity(value:Session|null) { sessionRef.current=value; setSession(value); }
  function clearIdentity() {
    sessionEpoch.current+=1;setLoading(false);
    setIdentity(null);setSnapshot({data:empty(),revision:0});revision.current=0;setReady(false);setError('');setConflict(false);retries.current.clear();
  }
  async function request<T>(path:string,options:RequestInit={}) {
    const epoch=sessionEpoch.current;
    try { const result=await api<T>(path,{...options,headers:{'X-CSRF-Token':sessionRef.current?.csrfToken||'',...options.headers}});if(epoch!==sessionEpoch.current)throw new StaleSessionError();return result; }
    catch(e) {if(epoch!==sessionEpoch.current)throw new StaleSessionError();if(e instanceof ApiError&&e.status===401)clearIdentity();throw e;}
  }
  function apply(next:Snapshot) {if(next.revision<revision.current)return;revision.current=next.revision;setSnapshot(next);setReady(true);setError('');setConflict(false);}
  async function refresh() {
    const epoch=sessionEpoch.current;
    try {apply(await request<Snapshot>('/data'));retries.current.clear();}
    catch(e){if(epoch===sessionEpoch.current)setError((e as Error).message);throw e;}
  }
  async function checkSession() {
    const epoch=sessionEpoch.current;
    setLoading(true);setError('');
    try {const identity=await api<Session>('/auth/session');if(epoch!==sessionEpoch.current)return;setIdentity(identity);await refresh();}
    catch(e) {if(epoch!==sessionEpoch.current)return;if(e instanceof ApiError&&e.status===401)clearIdentity();else setError((e as Error).message);}
    finally {if(epoch===sessionEpoch.current)setLoading(false);}
  }
  useEffect(()=>{void checkSession();},[]);
  async function authenticate(path:string,values:unknown) {
    clearIdentity();const epoch=sessionEpoch.current;
    const identity=await api<Session>(path,{method:'POST',body:JSON.stringify(values)});
    if(epoch!==sessionEpoch.current)throw new StaleSessionError();setIdentity(identity);
    try {await refresh();} catch { /* Workspace displays a retry if data is temporarily unavailable. */ }
  }
  async function mutate(path:string,method:string,body?:unknown) {
    const epoch=sessionEpoch.current;
    const fingerprint=JSON.stringify({path,method,body});
    const attempt=retries.current.get(fingerprint)||{key:createMessageId(),revision:revision.current};
    retries.current.set(fingerprint,attempt);
    try {
      const result=await request<Snapshot>(path,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{'If-Match':`"${attempt.revision}"`,'Idempotency-Key':attempt.key}});
      retries.current.delete(fingerprint);
      if(result.revision<revision.current)await refresh();else apply(result);
    } catch(e) {
      if(epoch!==sessionEpoch.current)throw new StaleSessionError();
      if(e instanceof ApiError&&e.status<500)retries.current.delete(fingerprint);
      if(e instanceof ApiError&&e.status===409){setConflict(true);setError('数据已发生变化。本次未保存，表单内容已保留。请刷新最新数据、核对内容后再次保存。');throw new Error('保存冲突：请先刷新最新数据并核对表单，本次输入已保留。');}
      throw e;
    }
  }
  return <Context.Provider value={{data:snapshot.data,revision:snapshot.revision,session,loading,ready,error,conflict,
    login:v=>authenticate('/auth/login',v),register:v=>authenticate('/auth/register',v),checkSession,refresh,
    logout:async()=>{await request('/auth/logout',{method:'POST'});clearIdentity();},
    save:(key,value)=>mutate(`/records/${key}/${encodeURIComponent(value.id)}`,'PUT',{value}),
    remove:(key,id)=>mutate(`/records/${key}/${encodeURIComponent(id)}`,'DELETE'),
    pay:value=>mutate(`/orders/${encodeURIComponent(value.orderId)}/payments`,'POST',value),
    adjustStock:value=>mutate(`/products/${encodeURIComponent(value.productId)}/stock-movements`,'POST',value),
    exportBackup:()=>request<Backup>('/backup'),restore:value=>mutate('/restore','POST',value),
    changePassword:async value=>{await request('/auth/password',{method:'POST',body:JSON.stringify(value)});},
    audit:async()=>(await request<{events:AuditEvent[]}>('/audit')).events,
    ask:(question,history)=>request('/assistant',{method:'POST',body:JSON.stringify({question,history:history.slice(-12).map(({role,content})=>({role,content}))})}),
  }}>{children}</Context.Provider>;
}
export function useStore(){const value=useContext(Context);if(!value)throw new Error('Missing StoreProvider');return value;}
