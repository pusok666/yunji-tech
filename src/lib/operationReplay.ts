import type { Receipt, StockMovement } from '../types';

// Compare the immutable server record with the exact normalized request payload.
// A changed balance alone never proves that an uncertain request was committed.
export function sameReceipt(record:Receipt, request:Receipt):boolean {
  return record.id===request.id&&record.orderId===request.orderId&&record.type===request.type&&
    record.amount===request.amount&&record.date===request.date&&record.notes===request.notes&&
    record.receiptId===request.receiptId;
}

export function sameStockMovement(record:StockMovement, request:StockMovement):boolean {
  return record.id===request.id&&record.productId===request.productId&&record.delta===request.delta&&
    record.date===request.date&&record.notes===request.notes;
}
