import type { BusinessData, Order, Period, Transaction } from '../types.ts';

export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const businessDateFormat = new Intl.DateTimeFormat('sv-SE', {timeZone:BUSINESS_TIME_ZONE});
export const today = (now:Date = new Date()) => localDate(now);
export function localDate(d:Date) { return businessDateFormat.format(d); }
// A date-only value is a calendar day, not a timestamp in the browser's timezone.
const calendarDay = (date:string) => new Date(`${date}T00:00:00Z`);
const calendarString = (date:Date) => date.toISOString().slice(0,10);
export function daysAgo(n:number, now:Date = new Date()) { const d=calendarDay(today(now));d.setUTCDate(d.getUTCDate()-n);return calendarString(d); }
export const money = (n: number) => `¥${n.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
export const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const total = (arr: number[]) => round(arr.reduce((a,b)=>a+b,0));
export const outstanding = (o: Order) => o.status === '已取消' ? 0 : Math.max(0,round(o.amount-o.paidAmount));
export function periodStart(period: Period, now:Date = new Date()) {
  if(period==='all')return '0000-01-01';
  const d=calendarDay(today(now));
  if(period==='week')d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));
  if(period==='month')d.setUTCDate(1);
  if(period==='year'){d.setUTCMonth(0);d.setUTCDate(1);}
  return calendarString(d);
}
export function ledger(data: BusinessData): Transaction[] {
  if(data.receipts) return [...data.transactions,...data.receipts.map(r=>{
    const order=data.orders.find(o=>o.id===r.orderId);
    return {id:r.id,orderId:r.orderId,title:`${order?.title||r.orderId} · ${r.type}`,type:r.type==='收款'?'收入' as const:'支出' as const,category:r.type==='退款'?'订单退款':order?.category||'订单回款',amount:r.amount,date:r.date,notes:r.notes};
  })].sort((a,b)=>b.date.localeCompare(a.date));
  return [...data.transactions, ...data.orders.filter(o=>o.paidAmount>0 && o.status!=='已取消').map(o=>({id:`receipt-${o.id}`, orderId:o.id, title:`${o.title} · 订单回款`, type:'收入' as const, category:o.category, amount:o.paidAmount, date:o.date, notes:'随订单已收金额同步，按订单日期统计'}))].sort((a,b)=>b.date.localeCompare(a.date));
}
export function metrics(data: BusinessData, period: Period = 'month', now:Date = new Date()) {
  const start=periodStart(period,now), end=today(now);
  const entries=ledger(data).filter(t=>t.date>=start && t.date<=end);
  const revenue=total(entries.filter(t=>t.type==='收入').map(t=>t.amount));
  const expense=total(entries.filter(t=>t.type==='支出').map(t=>t.amount));
  const orders=data.orders.filter(o=>o.date>=start && o.date<=end && o.status!=='已取消');
  return {revenue, expense, profit:round(revenue-expense), orders:orders.length, customers:data.customers.filter(c=>c.date<=end && (period==='all'||c.date>=start)).length, receivables:total(data.orders.map(outstanding)), lowStock:data.products.filter(p=>p.stock<=p.threshold), entries};
}
export function trend(data: BusinessData, period: Period, now:Date = new Date()) {
  const entries=ledger(data);const end=today(now);const d=calendarDay(end);
  const isLong=period==='year'||period==='all';
  const length=isLong?12:period==='week'?((d.getUTCDay()+6)%7)+1:d.getUTCDate();
  return Array.from({length},(_,i)=>{
    const date=new Date(Date.UTC(d.getUTCFullYear(),isLong?i:d.getUTCMonth(),isLong?1:period==='week'?d.getUTCDate()-length+1+i:i+1));
    const key=calendarString(date).slice(0,isLong?7:10);
    const list=entries.filter(t=>t.date.startsWith(key)&&t.date<=end);
    const revenue=total(list.filter(t=>t.type==='收入').map(t=>t.amount));
    const expense=total(list.filter(t=>t.type==='支出').map(t=>t.amount));
    return {label:isLong?`${i+1}月`:`${date.getUTCMonth()+1}/${date.getUTCDate()}`,revenue,expense,profit:round(revenue-expense)};
  });
}
export function validateData(value: unknown): value is BusinessData {
  if(!value||typeof value!=='object') return false;
  const d=value as BusinessData;
  if(d.version!==1||!['customers','orders','products','transactions'].every(k=>Array.isArray(d[k as keyof BusinessData]))) return false;
  const str=(v:unknown)=>typeof v==='string'; const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const date=(v:unknown)=>str(v)&&/^\d{4}-\d{2}-\d{2}$/.test(v as string)&&Number.isFinite(calendarDay(v as string).getTime())&&calendarString(calendarDay(v as string))===v;
  const unique=(a:{id:string}[])=>new Set(a.map(x=>x.id)).size===a.length&&a.every(x=>x&&str(x.id));
  try { return [d.customers,d.orders,d.products,d.transactions].every(unique)
    && d.customers.every(c=>[c.name,c.contact,c.phone,c.email,c.industry,c.notes].every(str)&&date(c.date)&&c.date<=today()&&c.name.trim().length>0&&['重点客户','普通客户','潜在客户'].includes(c.level))
    && d.orders.every(o=>[o.title,o.customerId,o.category,o.notes].every(str)&&date(o.date)&&o.date<=today()&&date(o.dueDate)&&o.dueDate>=o.date&&num(o.amount)&&o.amount>0&&num(o.paidAmount)&&o.paidAmount<=o.amount&&['待确认','进行中','已完成','已取消'].includes(o.status)&&d.customers.some(c=>c.id===o.customerId)&&(o.status!=='已取消'||o.paidAmount===0))
    && d.products.every(p=>[p.name,p.sku,p.category,p.unit,p.notes].every(str)&&[p.stock,p.threshold,p.price,p.cost].every(num)&&Number.isInteger(p.stock)&&Number.isInteger(p.threshold))
    && new Set(d.products.map(p=>p.sku.toLowerCase())).size===d.products.length
    && d.transactions.every(t=>[t.title,t.category,t.notes].every(str)&&date(t.date)&&t.date<=today()&&num(t.amount)&&t.amount>0&&['收入','支出'].includes(t.type)&&!t.orderId);
  } catch {return false;}
}
