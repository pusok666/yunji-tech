import { createHash, randomUUID } from 'node:crypto';
import type { Database, Executor } from './db.ts';
import { cents, dataSchema, emptyData, entitySchemas, fail, idSchema, movementSchema, parse, receiptSchema, today, validateRelations } from './validation.ts';
import type { BusinessData, Kind } from './validation.ts';
import { compactWorkspaceResponses, DEFAULT_IDEMPOTENCY_CACHE } from './idempotency.ts';
import type { IdempotencyCachePolicy } from './idempotency.ts';

export type Identity = { userId: string; workspaceId: string; sessionHash: string; csrfToken: string; email: string; name: string; workspaceName: string; emailVerified: boolean };
export type Snapshot = { data: BusinessData; revision: number; idempotency?: {replayed:true;responseExpired:true;committedRevision:number} };
export async function readSnapshot(tx: Executor, workspaceId: string): Promise<Snapshot> {
  const data = emptyData();
  const workspace = (await tx.query('SELECT revision FROM workspaces WHERE id=$1', [workspaceId])).rows[0];
  if (!workspace) fail('工作空间不存在', 404);
  for (const row of (await tx.query('SELECT kind,payload FROM records WHERE workspace_id=$1 ORDER BY created_at,id', [workspaceId])).rows) (data[row.kind as Kind] as any[]).push(row.payload);
  data.receipts = (await tx.query('SELECT payload FROM receipts WHERE workspace_id=$1 ORDER BY sequence,id', [workspaceId])).rows.map(r => r.payload);
  data.stockMovements = (await tx.query('SELECT payload FROM stock_movements WHERE workspace_id=$1 ORDER BY sequence,id', [workspaceId])).rows.map(r => r.payload);
  return { data, revision: workspace.revision };
}
function stable(value: any): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`; return JSON.stringify(value); }
function auditSummary(data: BusinessData, event: { kind: string; id: string }) {
  const fields: Record<string,string[]> = {
    customers: ['id','name','level'], orders: ['id','customerId','title','amount','paidAmount','status','date','dueDate'],
    products: ['id','name','sku','stock','threshold','price','cost'], transactions: ['id','title','type','category','amount','date'],
    receipts: ['id','orderId','type','amount','date','receiptId'], stockMovements: ['id','productId','delta','date','notes'],
  };
  if (event.kind === 'workspace') return Object.fromEntries(['customers','orders','products','transactions','receipts','stockMovements'].map(kind => [kind, (data as any)[kind].length]));
  const entity = (data as any)[event.kind]?.find((value: any) => value.id === event.id);
  if (!entity) return null;
  return Object.fromEntries((fields[event.kind] ?? ['id']).filter(key => entity[key] !== undefined).map(key => [key, entity[key]]));
}
export async function mutate(db: Database, who: Identity, request: { revision: number; key: string; method: string; path: string; body: unknown }, action: (tx: Executor, data: BusinessData) => Promise<{ action: string; kind: string; id: string }>, cache:IdempotencyCachePolicy=DEFAULT_IDEMPOTENCY_CACHE): Promise<Snapshot> {
  const hash = createHash('sha256').update(stable({ method: request.method, path: request.path, body: request.body ?? null })).digest('hex');
  return db.transaction(async tx => {
    const row = (await tx.query('SELECT revision FROM workspaces WHERE id=$1 FOR UPDATE', [who.workspaceId])).rows[0];
    if (!row) fail('工作空间不存在', 404);
    const previous = (await tx.query('SELECT request_hash,committed_revision FROM idempotency_keys WHERE workspace_id=$1 AND key=$2', [who.workspaceId, request.key])).rows[0];
    if (previous) {
      if (previous.request_hash !== hash) fail('同一请求编号已用于其他操作', 409, 'IDEMPOTENCY_CONFLICT');
      await compactWorkspaceResponses(tx,who.workspaceId,cache);
      const cached=(await tx.query('SELECT response FROM idempotency_keys WHERE workspace_id=$1 AND key=$2 AND response_expires_at>now()',[who.workspaceId,request.key])).rows[0];
      if(cached?.response)return cached.response;
      return {...await readSnapshot(tx,who.workspaceId),idempotency:{replayed:true,responseExpired:true,committedRevision:previous.committed_revision}};
    }
    if (row.revision !== request.revision) fail('数据已被其他操作更新，请刷新后重试', 409, 'REVISION_CONFLICT');
    const { data } = await readSnapshot(tx, who.workspaceId);
    const audit = await action(tx, data);
    await tx.query('UPDATE workspaces SET revision=revision+1 WHERE id=$1', [who.workspaceId]);
    const result = await readSnapshot(tx, who.workspaceId);
    const auditId=randomUUID();
    await tx.query('INSERT INTO audit_events(id,workspace_id,user_id,action,entity_kind,entity_id,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)', [auditId, who.workspaceId, who.userId, audit.action, audit.kind, audit.id, JSON.stringify(auditSummary(data, audit)), JSON.stringify(auditSummary(result.data, audit))]);
    // Oversized responses are returned to this caller but never stored as a large
    // cache value. The durable request receipt still commits with the business.
    await tx.query(`WITH value AS (SELECT $4::jsonb AS body), measured AS (
      SELECT body,octet_length(body::text) AS bytes FROM value
    ) INSERT INTO idempotency_keys(workspace_id,key,request_hash,response,committed_revision,response_expires_at,response_bytes,audit_event_id)
      SELECT $1,$2,$3,CASE WHEN $7>0 AND $8>0 AND bytes<=$9 THEN body ELSE NULL END,$5,
        now()+($7::double precision*interval '1 millisecond'),
        CASE WHEN $7>0 AND $8>0 AND bytes<=$9 THEN bytes ELSE 0 END,$6 FROM measured`,
    [who.workspaceId,request.key,hash,JSON.stringify(result),result.revision,auditId,cache.ttlMs,cache.maxEntries,cache.maxBytes]);
    await compactWorkspaceResponses(tx,who.workspaceId,cache);
    return result;
  });
}
const save = (tx: Executor, workspaceId: string, kind: Kind, value: any) => tx.query('INSERT INTO records(workspace_id,kind,id,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(workspace_id,kind,id) DO UPDATE SET payload=EXCLUDED.payload', [workspaceId, kind, value.id, JSON.stringify(value)]);
export async function putRecord(tx: Executor, workspaceId: string, data: BusinessData, kind: Kind, id: string, input: unknown) {
  const value = parse(entitySchemas[kind] as any, input) as any;
  if (id !== value.id) fail('路径编号与记录编号不一致');
  const existing: any = data[kind].find(v => v.id === id);
  if (kind === 'orders') {
    if (!data.customers.some(c => c.id === value.customerId)) fail('客户不存在', 404);
    if (cents(value.paidAmount) !== cents(existing?.paidAmount ?? 0)) fail('已收金额由收款流水计算，请使用登记收款');
    if (cents(value.amount) < cents(value.paidAmount)) fail('订单金额不能小于已收净额');
    if (value.status === '已取消' && value.paidAmount !== 0) fail('取消订单前请退清款项');
    if (data.receipts.some(r => r.orderId === id && r.date < value.date)) fail('订单日期不能晚于已有收款日期');
    if (existing && existing.customerId !== value.customerId && data.receipts.some(r => r.orderId === id)) fail('存在资金流水的订单不能更换客户');
  }
  if (kind === 'products') {
    if (data.products.some(p => p.id !== id && p.sku.toLowerCase() === value.sku.toLowerCase())) fail('商品 SKU 已存在', 409, 'DUPLICATE_SKU');
    if (existing && value.stock !== existing.stock) fail('库存只能通过出入库流水修改');
    if (!existing && value.stock > 0) {
      const movement = { id: randomUUID(), productId: id, delta: value.stock, date: today(), notes: '期初库存' };
      await tx.query('INSERT INTO stock_movements(workspace_id,id,product_id,payload) VALUES($1,$2,$3,$4::jsonb)', [workspaceId, movement.id, id, JSON.stringify(movement)]);
    }
  }
  await save(tx, workspaceId, kind, value);
  return { action: existing ? 'update' : 'create', kind, id };
}
export async function deleteRecord(tx: Executor, workspaceId: string, data: BusinessData, kind: Kind, id: string) {
  if (!data[kind].some(v => v.id === id)) fail('记录不存在', 404);
  if (kind === 'customers' && data.orders.some(o => o.customerId === id)) fail('客户有关联订单，不能删除', 409);
  if (kind === 'orders' && data.receipts.some(r => r.orderId === id)) fail('订单有资金流水，不能删除', 409);
  if (kind === 'products' && data.stockMovements.some(m => m.productId === id)) fail('商品有库存流水，不能删除', 409);
  await tx.query('DELETE FROM records WHERE workspace_id=$1 AND kind=$2 AND id=$3', [workspaceId, kind, id]);
  return { action: 'delete', kind, id };
}
export async function addPayment(tx: Executor, workspaceId: string, data: BusinessData, id: string, input: unknown) {
  const receipt = parse(receiptSchema, input);
  if (receipt.orderId !== id) fail('订单编号不匹配');
  const order = data.orders.find(o => o.id === id);
  if (!order) fail('订单不存在', 404);
  if (data.receipts.some(r => r.id === receipt.id)) fail('流水编号已存在', 409);
  if (receipt.date < order.date) fail('收款日期不能早于订单日期');
  if (receipt.type === '收款' && order.status === '已取消') fail('已取消订单不能新增收款');
  if (receipt.type === '收款' && receipt.receiptId) fail('收款不能关联其他收款');
  if (receipt.type === '退款') {
    const original = data.receipts.find(r => r.id === receipt.receiptId && r.orderId === id && r.type === '收款');
    if (!original) fail('请选择此订单的原收款记录');
    if (receipt.date < original.date) fail('退款日期不能早于原收款日期');
    const refunded = data.receipts.filter(r => r.type === '退款' && r.receiptId === original.id).reduce((n, r) => n + cents(r.amount), 0);
    if (refunded + cents(receipt.amount) > cents(original.amount)) fail('退款金额超过原收款可退余额');
  }
  const paid = cents(order.paidAmount) + (receipt.type === '收款' ? 1 : -1) * cents(receipt.amount);
  if (paid < 0 || paid > cents(order.amount)) fail('收退款金额超出订单可操作余额');
  await tx.query('INSERT INTO receipts(workspace_id,id,order_id,payload) VALUES($1,$2,$3,$4::jsonb)', [workspaceId, receipt.id, id, JSON.stringify(receipt)]);
  await save(tx, workspaceId, 'orders', { ...order, paidAmount: paid / 100 });
  return { action: receipt.type === '退款' ? 'refund' : 'receive', kind: 'receipts', id: receipt.id };
}
export async function addMovement(tx: Executor, workspaceId: string, data: BusinessData, id: string, input: unknown) {
  const movement = parse(movementSchema, input);
  if (movement.productId !== id) fail('商品编号不匹配');
  const product = data.products.find(p => p.id === id);
  if (!product) fail('商品不存在', 404);
  if (data.stockMovements.some(m => m.id === movement.id)) fail('流水编号已存在', 409);
  const stock = product.stock + movement.delta;
  if (stock < 0 || stock > 1_000_000_000) fail('库存不足或超过数量上限');
  let running = 0;
  for (const item of [...data.stockMovements.filter(m => m.productId === id), movement].sort((a,b) => a.date.localeCompare(b.date))) {
    running += item.delta; if (running < 0) fail('该日期的库存不足，请核对出入库日期');
  }
  await tx.query('INSERT INTO stock_movements(workspace_id,id,product_id,payload) VALUES($1,$2,$3,$4::jsonb)', [workspaceId, movement.id, id, JSON.stringify(movement)]);
  await save(tx, workspaceId, 'products', { ...product, stock });
  return { action: movement.delta > 0 ? 'stock-in' : 'stock-out', kind: 'stockMovements', id: movement.id };
}
export async function restoreBackup(tx: Executor, workspaceId: string, current: BusinessData, body: any) {
  if (['customers','orders','products','transactions','receipts','stockMovements'].some(k => (current as any)[k].length > 0)) fail('仅允许恢复到空工作空间，请创建新的工作空间账号后恢复', 409, 'WORKSPACE_NOT_EMPTY');
  if (!body || body.format !== 'yunji-commercial-backup' || body.version !== 1 || !Number.isInteger(body.revision) || body.revision < 0 || typeof body.exportedAt !== 'string' || Number.isNaN(Date.parse(body.exportedAt))) fail('备份文件格式无效');
  const data = parse(dataSchema, body.data); validateRelations(data);
  for (const kind of ['customers','orders','products','transactions'] as const) for (const item of data[kind]) await save(tx, workspaceId, kind, item);
  for (const r of data.receipts) await tx.query('INSERT INTO receipts(workspace_id,id,order_id,payload) VALUES($1,$2,$3,$4::jsonb)', [workspaceId, r.id, r.orderId, JSON.stringify(r)]);
  for (const m of data.stockMovements) await tx.query('INSERT INTO stock_movements(workspace_id,id,product_id,payload) VALUES($1,$2,$3,$4::jsonb)', [workspaceId, m.id, m.productId, JSON.stringify(m)]);
  return { action: 'restore', kind: 'workspace', id: workspaceId };
}
export function parseKind(value: unknown): Kind { if (typeof value !== 'string' || !Object.hasOwn(entitySchemas, value)) fail('模块不存在', 404); return value as Kind; }
export const parseId = (value: unknown) => parse(idSchema, value);
