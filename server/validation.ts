import { z } from 'zod';

export class HttpError extends Error { status: number; code: string; constructor(status: number, message: string, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; } }
export function fail(message: string, status = 400, code = 'INVALID_REQUEST'): never { throw new HttpError(status, message, code); }
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
export const cents = (value: number) => Math.round(value * 100);
const text = z.string().max(2000);
const required = z.string().trim().min(1).max(200);
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v && v >= '1900-01-01', '日期无效');
const pastDate = date.refine(v => v <= today(), '日期不能晚于今天');
const amount = z.number().finite().min(0).max(100_000_000).refine(v => Math.round(v * 100) / 100 === v, '金额最多两位小数');
const positiveAmount = amount.refine(v => v > 0, '金额必须大于零');
const quantity = z.number().int().min(0).max(1_000_000_000);
export const customerSchema = z.object({ id: idSchema, name: required, contact: text, phone: text, email: text, industry: text, level: z.enum(['重点客户','普通客户','潜在客户']), date: pastDate, notes: text }).strict();
export const orderSchema = z.object({ id: idSchema, customerId: idSchema, title: required, category: required, amount: positiveAmount, paidAmount: amount, status: z.enum(['待确认','进行中','已完成','已取消']), date: pastDate, dueDate: date, notes: text }).strict().refine(o => o.dueDate >= o.date, '到期日期不能早于订单日期');
export const productSchema = z.object({ id: idSchema, name: required, sku: required, category: required, stock: quantity, threshold: quantity, price: amount, cost: amount, unit: required, notes: text }).strict();
export const transactionSchema = z.object({ id: idSchema, title: required, type: z.enum(['收入','支出']), category: required, amount: positiveAmount, date: pastDate, notes: text }).strict();
export const receiptSchema = z.object({ id: idSchema, orderId: idSchema, type: z.enum(['收款','退款']), amount: positiveAmount, date: pastDate, notes: text, receiptId: idSchema.optional() }).strict();
export const movementSchema = z.object({ id: idSchema, productId: idSchema, delta: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine(v => v !== 0), date: pastDate, notes: z.string().trim().min(1).max(2000) }).strict();
export const entitySchemas = { customers: customerSchema, orders: orderSchema, products: productSchema, transactions: transactionSchema };
export type Kind = keyof typeof entitySchemas;
export const dataSchema = z.object({ version: z.literal(1), customers: z.array(customerSchema).max(20000), orders: z.array(orderSchema).max(20000), products: z.array(productSchema).max(20000), transactions: z.array(transactionSchema).max(20000), receipts: z.array(receiptSchema).max(20000), stockMovements: z.array(movementSchema).max(20000) }).strict();
export type BusinessData = z.infer<typeof dataSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type Movement = z.infer<typeof movementSchema>;
export const emptyData = (): BusinessData => ({ version: 1, customers: [], orders: [], products: [], transactions: [], receipts: [], stockMovements: [] });
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(`数据校验失败：${result.error.issues[0]?.message ?? '格式不正确'}`);
  return result.data as T;
}
export function validateRelations(data: BusinessData) {
  for (const key of ['customers','orders','products','transactions','receipts','stockMovements'] as const) {
    if (new Set(data[key].map(e => e.id)).size !== data[key].length) fail('备份中存在重复编号');
  }
  if (new Set(data.products.map(p => p.sku.toLowerCase())).size !== data.products.length) fail('商品 SKU 不可重复');
  const customers = new Set(data.customers.map(c => c.id));
  const orders = new Map(data.orders.map(o => [o.id, o]));
  const products = new Map(data.products.map(p => [p.id, p]));
  const receipts = new Map(data.receipts.map(r => [r.id, r]));
  const net = new Map<string, number>(); const refunded = new Map<string, number>();
  for (const r of data.receipts) {
    const order = orders.get(r.orderId);
    if (!order || r.date < order.date) fail('收款流水的订单关联或日期无效');
    if (r.type === '退款') {
      const original = r.receiptId && receipts.get(r.receiptId);
      if (!original || original.type !== '收款' || original.orderId !== r.orderId || r.date < original.date) fail('退款必须关联同订单的原收款，日期不能早于原收款');
      const sum = (refunded.get(original.id) ?? 0) + cents(r.amount);
      if (sum > cents(original.amount)) fail('退款不能超过原收款金额');
      refunded.set(original.id, sum);
    } else if (r.receiptId) fail('收款不能关联其他收款');
    net.set(r.orderId, (net.get(r.orderId) ?? 0) + (r.type === '收款' ? 1 : -1) * cents(r.amount));
  }
  for (const order of data.orders) {
    const paid = net.get(order.id) ?? 0;
    if (!customers.has(order.customerId)) fail('订单客户不存在');
    if (paid < 0 || paid > cents(order.amount) || cents(order.paidAmount) !== paid) fail('订单已收金额与收款流水不一致');
    if (order.status === '已取消' && paid !== 0) fail('取消订单前需要退清款项');
  }
  const stocks = new Map<string, number>();
  for (const m of data.stockMovements) {
    if (!products.has(m.productId)) fail('库存流水的商品不存在');
    stocks.set(m.productId, (stocks.get(m.productId) ?? 0) + m.delta);
  }
  for (const product of data.products) if ((stocks.get(product.id) ?? 0) !== product.stock) fail('商品库存与库存流水不一致');
  // Restored movement chronology must also be valid, including every intermediate balance.
  const balances = new Map<string, number>();
  for (const m of [...data.stockMovements].sort((a, b) => a.date.localeCompare(b.date))) {
    const value = (balances.get(m.productId) ?? 0) + m.delta;
    if (value < 0 || value > 1_000_000_000) fail('库存流水历史存在负库存或超出范围');
    balances.set(m.productId, value);
  }
}
