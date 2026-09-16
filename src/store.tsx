import { createContext, useContext, useState, type ReactNode } from 'react';
import type { BusinessData, Entity, EntityKey } from './types';
import { createSeed } from './data/seed';
import { validateData } from './lib/business';
export const STORAGE_KEY='yunji-business-v1';
type Store = {data:BusinessData; error:string; save:(key:EntityKey,value:Entity)=>void; remove:(key:EntityKey,id:string)=>void; replace:(data:BusinessData)=>void; reset:()=>void};
const Context=createContext<Store|null>(null);
function initial() {
  try { const raw=localStorage.getItem(STORAGE_KEY); if(!raw){const data=createSeed();localStorage.setItem(STORAGE_KEY,JSON.stringify(data)); return {data,error:''};} const data:unknown=JSON.parse(raw); if(!validateData(data)) throw new Error('备份格式不正确'); return {data,error:''}; }
  catch { return {data:createSeed(),error:'本地数据读取失败。当前显示临时演示数据，原始记录未覆盖。请先导出原始数据，再恢复演示数据。'}; }
}
export function StoreProvider({children}:{children:ReactNode}) {
  const [state,setState]=useState(initial);
  function commit(data:BusinessData, allowRecovery=false) {
    if(state.error&&!allowRecovery) throw new Error('请先导出原始数据并恢复演示数据，避免覆盖原记录。');
    if(!validateData(data)) throw new Error('数据校验失败，请检查金额、日期、重复 SKU 或客户关联。');
    try {localStorage.setItem(STORAGE_KEY,JSON.stringify(data));} catch {throw new Error('本地空间不足或浏览器禁止存储，保存未完成。请先导出备份。');}
    setState({data,error:''});
  }
  function save(key:EntityKey,value:Entity) {
    if(key==='products'&&'sku' in value&&state.data.products.some(p=>p.id!==value.id&&p.sku.toLowerCase()===value.sku.toLowerCase())) throw new Error('SKU 已存在，请使用唯一编码。');
    const list=state.data[key] as Entity[];
    const next=list.some(x=>x.id===value.id)?list.map(x=>x.id===value.id?value:x):[value,...list];
    commit({...state.data,[key]:next});
  }
  function remove(key:EntityKey,id:string) {
    if(key==='customers'&&state.data.orders.some(o=>o.customerId===id)) throw new Error('该客户已关联订单，请先处理关联订单后再删除。');
    commit({...state.data,[key]:state.data[key].filter(x=>x.id!==id)});
  }
  return <Context.Provider value={{...state,save,remove,replace:data=>commit(data,true),reset:()=>commit(createSeed(),true)}}>{children}</Context.Provider>;
}
export function useStore(){const value=useContext(Context);if(!value)throw new Error('Missing StoreProvider');return value;}
