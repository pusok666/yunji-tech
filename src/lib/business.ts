import type { BusinessData, Order, Period, Transaction } from '../types.ts';

export const today = () => localDate(new Date());
export function localDate(d: Date) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
export function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate()-n); return localDate(d); }
export const money = (n: number) => `¥${n.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
export const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const total = (arr: number[]) => round(arr.reduce((a,b)=>a+b,0));
export const outstanding = (o: Order) => o.status === '已取消' ? 0 : Math.max(0,round(o.amount-o.paidAmount));
export function periodStart(period: Period) {
  const d = new Date(); d.setHours(0,0,0,0);
  if(period === 'week') d.setDate(d.getDate() - ((d.getDay()+6)%7));
  if(period === 'month') d.setDate(1);
  if(period === 'year') { d.setMonth(0); d.setDate(1); }
  return period === 'all' ? '0000-01-01' : localDate(d);
}
export function ledger(data: BusinessData): Transaction[] {
  return [...data.transactions, ...data.orders.filter(o=>o.paidAmount>0 && o.status!=='已取消').map(o=>({id:`receipt-${o.id}`, orderId:o.id, title:`${o.title} · 订单回款`, type:'收入' as const, category:o.category, amount:o.paidAmount, date:o.date, notes:'随订单已收金额同步，按订单日期统计'}))].sort((a,b)=>b.date.localeCompare(a.date));
}
export function metrics(data: BusinessData, period: Period = 'month') {
  const start=periodStart(period), end=today();
  const entries=ledger(data).filter(t=>t.date>=start && t.date<=end);
  const revenue=total(entries.filter(t=>t.type==='收入').map(t=>t.amount));
  const expense=total(entries.filter(t=>t.type==='支出').map(t=>t.amount));
  const orders=data.orders.filter(o=>o.date>=start && o.date<=end && o.status!=='已取消');
  return {revenue, expense, profit:round(revenue-expense), orders:orders.length, customers:data.customers.filter(c=>c.date<=end && (period==='all'||c.date>=start)).length, receivables:total(data.orders.map(outstanding)), lowStock:data.products.filter(p=>p.stock<=p.threshold), entries};
}
export function trend(data: BusinessData, period: Period) {
  const entries=ledger(data); const d=new Date();
  const isLong=period==='year'||period==='all';
  const length=isLong?12:period==='week'?((d.getDay()+6)%7)+1:d.getDate();
  return Array.from({length},(_,i)=>{
    const date=new Date(d.getFullYear(),isLong?i:d.getMonth(),isLong?1:period==='week'?d.getDate()-length+1+i:i+1);
    const key=localDate(date).slice(0,isLong?7:10);
    const list=entries.filter(t=>t.date.startsWith(key)&&t.date<=today());
    const revenue=total(list.filter(t=>t.type==='收入').map(t=>t.amount));
    const expense=total(list.filter(t=>t.type==='支出').map(t=>t.amount));
    return {label:isLong?`${i+1}月`:`${date.getMonth()+1}/${date.getDate()}`,revenue,expense,profit:round(revenue-expense)};
  });
}
export function validateData(value: unknown): value is BusinessData {
  if(!value||typeof value!=='object') return false;
  const d=value as BusinessData;
  if(d.version!==1||!['customers','orders','products','transactions'].every(k=>Array.isArray(d[k as keyof BusinessData]))) return false;
  const str=(v:unknown)=>typeof v==='string'; const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const date=(v:unknown)=>str(v)&&/^\d{4}-\d{2}-\d{2}$/.test(v as string)&&localDate(new Date(`${v}T12:00:00`))===v;
  const unique=(a:{id:string}[])=>new Set(a.map(x=>x.id)).size===a.length&&a.every(x=>x&&str(x.id));
  try { return [d.customers,d.orders,d.products,d.transactions].every(unique)
    && d.customers.every(c=>[c.name,c.contact,c.phone,c.email,c.industry,c.notes].every(str)&&date(c.date)&&c.date<=today()&&c.name.trim().length>0&&['重点客户','普通客户','潜在客户'].includes(c.level))
    && d.orders.every(o=>[o.title,o.customerId,o.category,o.notes].every(str)&&date(o.date)&&o.date<=today()&&date(o.dueDate)&&o.dueDate>=o.date&&num(o.amount)&&o.amount>0&&num(o.paidAmount)&&o.paidAmount<=o.amount&&['待确认','进行中','已完成','已取消'].includes(o.status)&&d.customers.some(c=>c.id===o.customerId)&&(o.status!=='已取消'||o.paidAmount===0))
    && d.products.every(p=>[p.name,p.sku,p.category,p.unit,p.notes].every(str)&&[p.stock,p.threshold,p.price,p.cost].every(num)&&Number.isInteger(p.stock)&&Number.isInteger(p.threshold))
    && new Set(d.products.map(p=>p.sku.toLowerCase())).size===d.products.length
    && d.transactions.every(t=>[t.title,t.category,t.notes].every(str)&&date(t.date)&&t.date<=today()&&num(t.amount)&&t.amount>0&&['收入','支出'].includes(t.type)&&!t.orderId);
  } catch {return false;}
}
