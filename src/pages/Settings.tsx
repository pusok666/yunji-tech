import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Form, Input, Table, App as AntApp } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { PageHeading, Panel } from '../components/Shared';
import { useStore, type AuditEvent } from '../store';
import { EmailVerificationStatus } from './AuthRecovery';
import { BUSINESS_TIME_ZONE } from '../lib/business';
const names:Record<string,string>={customers:'客户',orders:'订单',products:'商品',transactions:'收支',receipts:'收退款',stockMovements:'库存流水',create:'创建',update:'更新',delete:'删除',restore:'恢复备份',payment:'收退款',stock_movement:'库存变更','stock-in':'入库','stock-out':'出库',refund:'退款',receive:'收款'};
export default function Settings(){
  const {session,changePassword,audit}=useStore();const {message}=AntApp.useApp();
  const [events,setEvents]=useState<AuditEvent[]>([]);const [loading,setLoading]=useState(false);const [saving,setSaving]=useState(false);const [error,setError]=useState('');const [form]=Form.useForm();
  async function load(){setLoading(true);try{setEvents(await audit());setError('');}catch(e){setError((e as Error).message);}finally{setLoading(false);}}
  useEffect(()=>{void load();},[]);
  async function update(values:{currentPassword:string;newPassword:string}){setSaving(true);try{await changePassword({currentPassword:values.currentPassword,newPassword:values.newPassword});message.success('密码已更新，其他设备的登录已失效');form.resetFields();}catch(e){message.error((e as Error).message);}finally{setSaving(false);}}
  return <div className="page-enter"><PageHeading title="空间设置" description="管理账号安全，查看经营记录的变更。"/>
    <div className="settings-grid"><Panel title="经营空间"><Descriptions column={1} items={[{key:'space',label:'空间名称',children:session?.workspace.name},{key:'name',label:'姓名',children:session?.user.name},{key:'email',label:'登录邮箱',children:session?.user.email},{key:'role',label:'空间角色',children:'所有者'}]}/><div style={{marginBottom:20}}><EmailVerificationStatus/></div><Alert type="info" showIcon message="备份与恢复" description="通过右上角账号菜单导出经营备份。恢复仅对空空间开放，避免覆盖已有业务历史。"/></Panel>
    <Panel title="修改密码"><Form name="change-password" form={form} layout="vertical" onFinish={update} disabled={saving}><Form.Item name="currentPassword" label="当前密码" rules={[{required:true,message:'请输入当前密码'}]}><Input.Password autoComplete="current-password" maxLength={128}/></Form.Item><Form.Item name="newPassword" label="新密码" rules={[{required:true,message:'请输入新密码'},{min:12,message:'新密码至少 12 个字符'}]}><Input.Password autoComplete="new-password" maxLength={128}/></Form.Item><Form.Item name="confirm" label="确认新密码" dependencies={['newPassword']} rules={[{required:true,message:'请确认新密码'},({getFieldValue})=>({validator:(_,v)=>v===getFieldValue('newPassword')?Promise.resolve():Promise.reject(new Error('两次输入的密码不一致'))})]}><Input.Password autoComplete="new-password" maxLength={128}/></Form.Item><Button type="primary" htmlType="submit" loading={saving}>更新密码</Button></Form></Panel></div>
    <Panel title="操作记录" subtitle="当前空间的业务变更历史" extra={<Button icon={<ReloadOutlined/>} loading={loading} onClick={()=>void load()}>刷新记录</Button>}>{error&&<Alert type="error" message={error} style={{marginBottom:16}}/>}<Table<AuditEvent> rowKey="id" loading={loading} dataSource={events} scroll={{x:720}} pagination={{pageSize:10,showSizeChanger:false}} columns={[{title:'时间（北京时间）',dataIndex:'createdAt',width:190,render:v=>new Date(v).toLocaleString('zh-CN',{timeZone:BUSINESS_TIME_ZONE})},{title:'操作',dataIndex:'action',render:v=>names[v]||v},{title:'对象',dataIndex:'entityKind',render:v=>names[v]||v},{title:'记录编号',dataIndex:'entityId',ellipsis:true}]} locale={{emptyText:'暂无操作记录'}}/></Panel>
  </div>;
}
