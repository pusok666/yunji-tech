import { useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Table, Tag, App as AntApp } from 'antd';
import { useStore } from '../store';
import { money, outstanding, round, today, total } from '../lib/business';
import { createMessageId } from '../lib/messageId';
import type { Receipt, StockMovement } from '../types';

export function ConflictNotice(){
  const {conflict,refresh}=useStore();const {message}=AntApp.useApp();const [loading,setLoading]=useState(false);
  if(!conflict)return null;
  return <Alert type="warning" showIcon message="数据版本发生变化，当前输入尚未保存" description="刷新后会保留表单，请核对最新余额或库存，再确认提交。" style={{marginBottom:18}} action={<Button loading={loading} size="small" onClick={async()=>{setLoading(true);try{await refresh();message.info('已刷新，请核对表单后重新提交');}catch(e){message.error((e as Error).message);}finally{setLoading(false);}}}>刷新并保留输入</Button>}/>;
}

export function OrderPayments({orderId,onClose}:{orderId:string;onClose:()=>void}){
  const {data,pay,conflict}=useStore();const {message}=AntApp.useApp();const [form]=Form.useForm();const [busy,setBusy]=useState(false);const [intent,setIntent]=useState(createMessageId);
  const order=data.orders.find(o=>o.id===orderId);const receipts=(data.receipts||[]).filter(r=>r.orderId===orderId);
  const type=Form.useWatch('type',form)||'收款';const receiptId=Form.useWatch('receiptId',form);
  const refundable=receipts.filter(r=>r.type==='收款').map(r=>({...r,balance:round(r.amount-total(receipts.filter(x=>x.type==='退款'&&x.receiptId===r.id).map(x=>x.amount)))})).filter(r=>r.balance>0);
  const limit=type==='收款'?(order?outstanding(order):0):refundable.find(r=>r.id===receiptId)?.balance||0;
  async function submit(){
    try{const values=await form.validateFields();if(busy)return;setBusy(true);await pay({id:intent,orderId,type:values.type,amount:values.amount,date:values.date,notes:values.notes?.trim()||'',...(values.type==='退款'?{receiptId:values.receiptId}:{})});message.success(`${values.type}已登记，账本同步更新`);setIntent(createMessageId());form.resetFields();}
    catch(e){if(e instanceof Error)message.error(e.message);}finally{setBusy(false);}
  }
  return <Modal title={`收款与退款 · ${order?.title||'订单'}`} open onCancel={()=>{if(!busy)onClose();}} footer={<><Button disabled={busy} onClick={onClose}>关闭</Button><Button type="primary" loading={busy} disabled={conflict||!order} onClick={()=>void submit()}>登记{type}</Button></>} width={780} maskClosable={!busy}>
    <ConflictNotice/>
    <div className="flow-summary"><span>订单金额 <strong>{money(order?.amount||0)}</strong></span><span>已收净额 <strong>{money(order?.paidAmount||0)}</strong></span><span>待回款 <strong>{money(order?outstanding(order):0)}</strong></span></div>
    <Form name="order-payments" form={form} layout="vertical" disabled={busy} initialValues={{type:'收款',date:today(),notes:''}}>
      <div className="form-two"><Form.Item name="type" label="操作类型" rules={[{required:true}]}><Select options={[{value:'收款',label:'登记收款',disabled:order?.status==='已取消'},{value:'退款',label:'登记退款'}]} onChange={()=>form.setFieldsValue({amount:undefined,receiptId:undefined})}/></Form.Item><Form.Item name="date" label="实际发生日期" rules={[{required:true,message:'请选择实际日期'},{validator:(_,v)=>!v||v<=today()?Promise.resolve():Promise.reject(new Error('日期不能晚于今天'))}]}><Input type="date" max={today()}/></Form.Item></div>
      {type==='退款'&&<Form.Item name="receiptId" label="原收款流水" rules={[{required:true,message:'请选择要退还的原收款'}]}><Select placeholder="选择原收款" options={refundable.map(r=>({value:r.id,label:`${r.date} · ${money(r.amount)} · 可退 ${money(r.balance)}`}))} notFoundContent="没有可退款的收款记录"/></Form.Item>}
      <Form.Item name="amount" label={`${type}金额（元）`} extra={`当前最多可${type==='收款'?'收':'退'} ${money(limit)}`} rules={[{required:true,message:'请输入金额'},{validator:(_,v)=>typeof v==='number'&&v>0&&v<=limit?Promise.resolve():Promise.reject(new Error(`金额需大于 0，且不超过 ${money(limit)}`))}]}><InputNumber min={0.01} max={limit} precision={2} style={{width:'100%'}}/></Form.Item>
      <Form.Item name="notes" label="说明"><Input.TextArea maxLength={500} rows={2} placeholder="例如：合同首付款 / 协商退款"/></Form.Item>
    </Form>
    <h4>历史流水</h4><Table<Receipt> size="small" rowKey="id" dataSource={[...receipts].reverse()} scroll={{x:520}} pagination={{pageSize:5,showSizeChanger:false}} columns={[{title:'日期',dataIndex:'date',width:115},{title:'类型',dataIndex:'type',width:85,render:v=><Tag color={v==='收款'?'green':'orange'}>{v}</Tag>},{title:'金额',dataIndex:'amount',render:money},{title:'备注',dataIndex:'notes',ellipsis:true}]} locale={{emptyText:'尚无收退款流水'}}/>
    <p className="records-note">流水按实际日期入账并保留历史。取消订单前需退清余额；退款应关联原收款。</p>
  </Modal>;
}

export function StockAdjust({productId,onClose}:{productId:string;onClose:()=>void}){
  const {data,adjustStock,conflict}=useStore();const {message}=AntApp.useApp();const [form]=Form.useForm();const [busy,setBusy]=useState(false);const [intent,setIntent]=useState(createMessageId);
  const product=data.products.find(p=>p.id===productId);const movements=(data.stockMovements||[]).filter(m=>m.productId===productId);
  const direction=Form.useWatch('direction',form)||'in';
  async function submit(){try{const values=await form.validateFields();if(busy)return;setBusy(true);await adjustStock({id:intent,productId,delta:values.direction==='in'?values.quantity:-values.quantity,date:values.date,notes:values.notes.trim()});message.success('库存变动已登记');setIntent(createMessageId());form.resetFields();}catch(e){if(e instanceof Error)message.error(e.message);}finally{setBusy(false);}}
  return <Modal title={`出入库登记 · ${product?.name||'商品'}`} open onCancel={()=>{if(!busy)onClose();}} footer={<><Button disabled={busy} onClick={onClose}>关闭</Button><Button type="primary" loading={busy} disabled={conflict||!product} onClick={()=>void submit()}>登记库存变动</Button></>} width={700} maskClosable={!busy}>
    <ConflictNotice/><div className="flow-summary">当前库存 <strong>{product?.stock||0} {product?.unit}</strong><span>库存通过独立流水记录，订单不自动扣减。</span></div>
    <Form name="stock-adjust" form={form} layout="vertical" disabled={busy} initialValues={{direction:'in',date:today()}}><div className="form-two"><Form.Item name="direction" label="变动类型" rules={[{required:true}]}><Select options={[{value:'in',label:'入库 / 盘盈'},{value:'out',label:'出库 / 盘亏'}]}/></Form.Item><Form.Item name="quantity" label="数量" rules={[{required:true,message:'请输入数量'},{validator:(_,v)=>Number.isInteger(v)&&v>0&&(direction==='in'||v<=(product?.stock||0))?Promise.resolve():Promise.reject(new Error('请输入正整数，出库数量不能超过当前库存'))}]}><InputNumber min={1} max={direction==='out'?product?.stock:9999999} precision={0}/></Form.Item></div><Form.Item name="date" label="实际发生日期" rules={[{required:true},{validator:(_,v)=>!v||v<=today()?Promise.resolve():Promise.reject(new Error('日期不能晚于今天'))}]}><Input type="date" max={today()}/></Form.Item><Form.Item name="notes" label="变动原因" rules={[{required:true,whitespace:true,message:'请填写变动原因，保留库存依据'}]}><Input.TextArea maxLength={500} rows={2} placeholder="如：采购入库、订单发货、盘点调整"/></Form.Item></Form>
    <h4>库存流水</h4><Table<StockMovement> size="small" rowKey="id" dataSource={[...movements].reverse()} scroll={{x:480}} pagination={{pageSize:5,showSizeChanger:false}} columns={[{title:'日期',dataIndex:'date',width:115},{title:'变动量',dataIndex:'delta',width:100,render:v=><Tag color={v>0?'green':'orange'}>{v>0?'+':''}{v}</Tag>},{title:'原因',dataIndex:'notes'}]} locale={{emptyText:'尚无库存流水'}}/>
  </Modal>;
}
