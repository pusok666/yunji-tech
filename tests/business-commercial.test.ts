import test from 'node:test';
import assert from 'node:assert/strict';
import { ledger, metrics, outstanding, today, trend, total } from '../src/lib/business.ts';
import type { BusinessData } from '../src/types.ts';

function fixture():BusinessData { return {
  version:1, customers:[], products:[], stockMovements:[],
  orders:[{id:'order',customerId:'client',title:'项目服务',category:'技术服务',amount:1000,paidAmount:900,status:'进行中',date:'2026-01-01',dueDate:'2026-12-31',notes:''}],
  receipts:[{id:'r1',orderId:'order',type:'收款',amount:400,date:today(),notes:''},{id:'r2',orderId:'order',type:'收款',amount:600,date:today(),notes:''},{id:'refund',orderId:'order',type:'退款',receiptId:'r1',amount:100,date:today(),notes:''}],
  transactions:[{id:'expense',title:'房租',type:'支出',category:'场地费用',amount:200,date:today(),notes:''}],
}; }
test('独立收款不会再次与订单已收金额重复计入',()=>{const d=fixture();assert.equal(ledger(d).length,4);assert.equal(metrics(d,'all').revenue,1000);});
test('退款属于现金流出，现金结余为流入减流出',()=>{const m=metrics(fixture(),'all');assert.equal(m.expense,300);assert.equal(m.profit,700);assert.equal(m.receivables,100);});
test('收入由实际收款日期确定，改订单日期不移动流水',()=>{const d=fixture();const before=ledger(d);d.orders[0].date='2026-01-02';assert.deepEqual(ledger(d),before);assert.equal(metrics(d,'month').revenue,1000);});
test('退款后取消订单仍保留历史现金流',()=>{const d=fixture();d.receipts!.push({id:'rest-refund1',orderId:'order',type:'退款',receiptId:'r1',amount:300,date:today(),notes:''},{id:'rest-refund2',orderId:'order',type:'退款',receiptId:'r2',amount:600,date:today(),notes:''});d.orders[0].status='已取消';d.orders[0].paidAmount=0;assert.equal(outstanding(d.orders[0]),0);assert.equal(metrics(d,'all').revenue,1000);assert.equal(ledger(d).length,6);});
test('周月图表与统计使用同一现金口径',()=>{const d=fixture();assert.equal(total(trend(d,'week').map(x=>x.revenue)),metrics(d,'week').revenue);assert.equal(total(trend(d,'month').map(x=>x.expense)),metrics(d,'month').expense);});
test('空经营空间可正常显示零值',()=>{const d:BusinessData={version:1,customers:[],orders:[],products:[],transactions:[],receipts:[],stockMovements:[]};assert.equal(metrics(d).revenue,0);assert.equal(metrics(d).profit,0);assert.deepEqual(ledger(d),[]);});
test('已有服务器 receipts 空数组时不会回退到演示派生回款',()=>{const d=fixture();d.receipts=[];assert.equal(metrics(d,'all').revenue,0);});
