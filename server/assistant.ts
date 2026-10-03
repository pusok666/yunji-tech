import { cents, today } from './validation.ts';
import type { BusinessData } from './validation.ts';
const money = (n: number) => `¥${(n/100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function rulesReply(question: string, data: BusinessData): string {
  const q = question.trim(), now = today();
  const heading = '【规则助手 · 当前工作空间服务器数据】\n\n';
  if (/上周|上个?月|去年|昨天|前天|最近\s*\d+\s*天/.test(q)) return heading + '目前支持今日、本周、本月、今年及累计查询，请使用这些时间范围。';
  let start = now.slice(0,7) + '-01', label = '本月';
  if (/今天|今日|日报/.test(q)) { start = now; label = '今日'; }
  else if (/本周|这周|周报/.test(q)) { const date = new Date(now+'T00:00:00Z'); date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7)); start = date.toISOString().slice(0,10); label='本周'; }
  else if (/今年|年度/.test(q)) { start = now.slice(0,4)+'-01-01'; label='今年'; }
  else if (/全部|累计|所有/.test(q)) { start='1900-01-01'; label='累计'; }
  const pending = data.orders.filter(o => o.status !== '已取消' && cents(o.amount) > cents(o.paidAmount)).sort((a,b) => a.dueDate.localeCompare(b.dueDate));
  const outstanding = pending.reduce((n,o) => n+cents(o.amount)-cents(o.paidAmount),0);
  const low = data.products.filter(p => p.stock <= p.threshold);
  if (/未回款|待回款|催款|欠款|应收/.test(q)) return heading+`截至 ${now}，${pending.length} 笔订单待回款，共 ${money(outstanding)}。\n\n`+pending.slice(0,30).map(o => `• ${data.customers.find(c=>c.id===o.customerId)?.name}｜${o.title}：待收 ${money(cents(o.amount)-cents(o.paidAmount))}，到期 ${o.dueDate}${o.dueDate<now?'（已逾期）':''}`).join('\n')+(pending.length>30?'\n仅展示前 30 笔，请到订单列表查看全部。':'')+'\n\n收到款项后，请在订单中登记独立收款流水。';
  if (/库存|缺货|补货/.test(q)) return heading+`${data.products.length} 种商品中，${low.length} 种达到预警线。\n\n`+(low.length?low.slice(0,30).map(p=>`• ${p.name}（${p.sku}）：当前 ${p.stock} ${p.unit}，预警线 ${p.threshold} ${p.unit}。`).join('\n'):'目前没有库存预警。')+'\n\n补货前请核对实物数量和销售情况；实际出入库需登记流水。';
  const inRange = (date:string) => date>=start && date<=now;
  let income=0,expense=0,refund=0;
  for (const r of data.receipts.filter(r=>inRange(r.date))) if(r.type==='收款') income+=cents(r.amount); else refund+=cents(r.amount);
  for (const t of data.transactions.filter(t=>inRange(t.date))) if(t.type==='收入') income+=cents(t.amount); else expense+=cents(t.amount);
  const orders=data.orders.filter(o=>inRange(o.date)&&o.status!=='已取消').length;
  if (/客户/.test(q) && !/总结|经营|日报|周报/.test(q)) return heading+`当前客户 ${data.customers.length} 位，${label}新增 ${data.customers.filter(c=>inRange(c.date)).length} 位。`;
  if (/订单/.test(q) && !/总结|经营|日报|周报/.test(q)) return heading+`${label}有效订单 ${orders} 笔。当前累计待回款 ${pending.length} 笔，共 ${money(outstanding)}。`;
  if (/收入|营收|利润|支出|成本|日报|周报|总结|分析|情况|经营|建议|今天|今日/.test(q)) return heading+`${label}经营${/日报/.test(q)?'日报':/周报/.test(q)?'周报':'摘要'} · ${start} — ${now}\n\n现金流入（收款及手动收入）：${money(income)}\n现金流出（含退款）：${money(expense+refund)}\n其中订单退款：${money(refund)}\n其中经营支出：${money(expense)}\n收支结余：${money(income-refund-expense)}\n有效订单：${orders} 笔\n新增客户：${data.customers.filter(c=>inRange(c.date)).length} 位\n\n待办：跟进 ${pending.length} 笔待回款订单（${money(outstanding)}），核对 ${low.length} 种预警商品。\n\n口径：按实际流水日期统计，退款计入现金流出并单列；收支结余不等于完整会计净利润。回答由本地规则生成，不执行修改。`;
  return heading+'支持自然语言查询收入、支出、客户和订单，生成日报/周报/经营总结，查询未回款和库存预警。请试试“生成本周经营周报”。当前尚未接入外部大模型。';
}
