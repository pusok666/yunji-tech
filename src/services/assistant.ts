import type { BusinessData, ChatMessage, Period } from '../types.ts';
import { ledger, metrics, money, outstanding, periodStart, today, total } from '../lib/business.ts';
export interface AssistantProvider { reply:(question:string,data:BusinessData,history:ChatMessage[])=>Promise<string> }
export function mockReply(question:string,data:BusinessData):string {
  const q=question.trim();
  if(/上周|上个星期|上个?月|去年|上年度|昨天|前天|最近\s*\d+\s*天/.test(q))return '当前本地助手支持今日、本周、本月、今年及累计数据查询，暂不支持这个历史时间范围。请试试“生成本周经营周报”或“本月收入有多少？”。';
  const period:Period=/今年|年度/.test(q)?'year':/全部|累计|所有/.test(q)?'all':/本周|这周|这个星期|本星期|周报|一周/.test(q)?'week':'month';
  const label=period==='year'?'今年':period==='week'?'本周':period==='all'?'累计':'本月';
  const m=metrics(data,period); const pending=data.orders.filter(o=>outstanding(o)>0).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const stock=m.lowStock;
  if(/未回款|待回款|催款|欠款|应收/.test(q))return `待回款订单 · 截至 ${today()}\n\n共有 ${pending.length} 笔订单待回款，合计 ${money(total(pending.map(outstanding)))}。\n\n${pending.length?pending.map(o=>`• ${data.customers.find(c=>c.id===o.customerId)?.name}｜${o.title}\n  ${o.id} · 待收 ${money(outstanding(o))} · ${o.dueDate}${o.dueDate<today()?'（已逾期）':''}`).join('\n\n'):'全部订单已结清，当前没有待回款。'}\n\n建议：优先跟进已逾期订单，确认付款节点；收到款项后，更新订单的已收金额即可同步入账。`;
  if(/库存|缺货|补货/.test(q))return `库存健康检查\n\n当前管理 ${data.products.length} 种商品，其中 ${stock.length} 种达到预警线。\n\n${stock.length?stock.map(p=>`• ${p.name}（${p.sku}）\n  当前 ${p.stock} ${p.unit} / 安全库存 ${p.threshold} ${p.unit}，建议至少补充 ${Math.max(1,p.threshold*2-p.stock)} ${p.unit}。`).join('\n\n'):'所有商品库存均高于安全线。'}\n\n建议：先处理缺货商品，再根据实际销售速度安排采购。补货量仅为基于安全库存的规则建议。`;
  if(/日报|今日|今天/.test(q)) {
    const entries=ledger(data).filter(t=>t.date===today());const revenue=total(entries.filter(t=>t.type==='收入').map(t=>t.amount));const expense=total(entries.filter(t=>t.type==='支出').map(t=>t.amount));
    return `云迹经营日报 · ${today()}\n\n今日收入：${money(revenue)}\n今日支出：${money(expense)}\n今日收支结余：${money(revenue-expense)}\n今日订单：${data.orders.filter(o=>o.date===today()&&o.status!=='已取消').length} 笔\n新增客户：${data.customers.filter(c=>c.date===today()).length} 位\n\n待办提醒\n• 跟进 ${pending.length} 笔未结清订单，待收 ${money(m.receivables)}。\n• 检查 ${stock.length} 种预警商品的补货计划。\n\n统计依据：今日收支记录与订单回款；订单回款按订单日期计入。`;
  }
  if(/周报|总结|分析|情况|怎么样|经营|建议/.test(q))return `${label}经营${/周报/.test(q)?'周报':'总结'} · ${periodStart(period)==='0000-01-01'?'全部记录':periodStart(period)} — ${today()}\n\n01  经营表现\n营业收入 ${money(m.revenue)}，经营支出 ${money(m.expense)}，净利润 ${money(m.profit)}。${m.revenue>0?`收支利润率为 ${(m.profit/m.revenue*100).toFixed(1)}%。`:'当前期间暂无收入。'}\n完成记录 ${m.orders} 笔有效订单，新增 ${m.customers} 位客户。\n\n02  需要关注\n• 目前待回款 ${money(m.receivables)}，涉及 ${pending.length} 笔订单。\n• ${stock.length} 种商品达到库存预警线。\n${m.profit<0?'• 当前支出高于收入，建议检查大额支出与回款进度。':'• 保持收支记录完整，有助于持续判断业务健康度。'}\n\n03  下一步建议\n${pending.length?'优先联系待回款客户，确认付款时间；':'维护现有客户，寻找复购机会；'}${stock.length?'核对库存后分批补货；':'持续关注畅销商品库存；'}每周复盘一次收入来源与支出结构。\n\n口径：净利润为收款收入减实际支出；建议由本地规则生成，数据来自当前工作台。`;
  if(/收入|营收|营业额/.test(q))return `${label}营业收入为 ${money(m.revenue)}。\n\n由订单已收金额与手动收入流水组成，不含未收款。同期支出 ${money(m.expense)}，净利润 ${money(m.profit)}。\n\n可继续问我“未回款订单”或“生成本周经营周报”。`;
  if(/利润|支出|成本/.test(q))return `${label}经营支出 ${money(m.expense)}，净利润 ${money(m.profit)}。\n\n收入 ${money(m.revenue)} − 支出 ${money(m.expense)} = 净利润 ${money(m.profit)}。\n此处采用收付实现口径，未考虑折旧、应计费用等正式会计调整。`;
  if(/客户/.test(q))return `当前共有 ${data.customers.length} 位客户，其中重点客户 ${data.customers.filter(c=>c.level==='重点客户').length} 位。${label}新增 ${m.customers} 位。\n\n你可以在客户管理中查看联系信息、合作金额和客户分级。`;
  if(/订单/.test(q))return `${label}共有 ${m.orders} 笔有效订单（不含已取消）。所有订单中仍有 ${pending.length} 笔未结清，待回款 ${money(m.receivables)}。\n\n输入“未回款订单”可查看具体客户、金额与约定回款日期。`;
  return '我可以根据当前经营数据，帮你查询与总结：\n\n• 本月收入有多少？\n• 生成今日经营日报\n• 生成本周经营周报\n• 哪些订单还未回款？\n• 有哪些库存预警？\n• 总结目前的经营情况\n\n当前为本地规则演示，暂不支持开放知识问答或直接修改业务数据。请试试上面的问法。';
}
export const mockAssistant:AssistantProvider={async reply(question,data){await new Promise(resolve=>setTimeout(resolve,650));return mockReply(question,data);}};
// Future integration: use a same-origin server proxy; never put provider API keys in browser code.
export function createApiAssistant(endpoint='/api/assistant'):AssistantProvider {
  return {async reply(question,data,history){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question,context:data,history:history.slice(-10)}),signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('AI 服务暂时不可用，请稍后重试。');const result:unknown=await response.json();if(!result||typeof result!=='object'||!('answer' in result)||typeof result.answer!=='string')throw new Error('AI 服务返回格式不正确');return result.answer;}};
}
export const assistantProvider=mockAssistant;
