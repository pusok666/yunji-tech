import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Form, Input, Modal, Result, Space, Tag, App as AntApp } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { CheckCircleOutlined, MailOutlined } from '@ant-design/icons';
import { needsEmailVerification, useStore, type AuthCapabilities } from '../store';
import { api, ApiError } from '../services/api';
import { forgetAuthLinkToken, readAuthLinkToken, type AuthLinkKind } from '../lib/authLink';

function safeError(error:unknown){
  if(error instanceof ApiError&&error.code==='AUTH_TOKEN_INVALID')return '此链接已失效或无法使用，请重新申请。';
  if(error instanceof ApiError&&error.code==='EMAIL_NOT_CONFIGURED')return '当前未配置邮件服务，请联系管理员。';
  return error instanceof Error?error.message:'操作暂时未完成，请稍后重试。';
}
function AuthCard({children,testId}:{children:ReactNode;testId:string}){
  return <main className="auth-recovery-page" data-testid={testId}><div className="auth-recovery-card"><Link className="brand" to="/login"><img src="/favicon.svg" alt=""/><span>云迹科技<small>YUNJI TECHNOLOGY</small></span></Link>{children}</div><p className="auth-recovery-footer">让小生意，也有大视野。</p></main>;
}
export function EmailVerificationStatus({showContinue=false}:{showContinue?:boolean}){
  const {session,requestVerification,checkSession}=useStore();
  const [busy,setBusy]=useState(false);const [queued,setQueued]=useState(false);const [checking,setChecking]=useState(false);const [error,setError]=useState('');
  if(!session)return null;
  async function resend(){setBusy(true);setError('');try{await requestVerification();setQueued(true);}catch(e){setError(safeError(e));}finally{setBusy(false);}}
  return <div className="email-verification-status">
    <Tag color={session.user.emailVerified?'green':'gold'} icon={session.user.emailVerified?<CheckCircleOutlined/>:<MailOutlined/>}>{session.user.emailVerified?'邮箱已验证':'邮箱待验证'}</Tag>
    {session.user.emailVerified?<p>你的登录邮箱已完成归属验证。</p>:<><p>验证邮箱后，可更安全地找回密码和使用经营空间。</p>
      {!session.auth?.emailEnabled?<Alert type="info" showIcon message="当前未配置邮件服务" description="暂不能发送验证或密码重置邮件，请联系管理员。"/>:<>
        {queued&&<Alert type="success" showIcon message="验证邮件申请已受理" description="请查收收件箱或垃圾邮件。邮件投递可能需要片刻；未收到时可稍后重新申请。"/>}
        {!queued&&session.emailDelivery==='unavailable'&&<Alert type="warning" showIcon message="账号已创建，邮件暂未排队" description="请稍后重新发送验证邮件。"/>}
        <Space wrap style={{marginTop:16}}><Button icon={<MailOutlined/>} loading={busy} onClick={()=>void resend()}>重新发送验证邮件</Button>{showContinue&&<Button type="primary" loading={checking} onClick={async()=>{setChecking(true);await checkSession();setChecking(false);}}>我已验证，继续进入</Button>}</Space>
      </>}
      {error&&<Alert style={{marginTop:14}} type="error" showIcon message={error}/>}</>}
  </div>;
}
export function VerificationRequired(){
  const {session,error,logout}=useStore();const {message}=AntApp.useApp();const [leaving,setLeaving]=useState(false);
  async function leave(){setLeaving(true);try{await logout();}catch(e){message.error(safeError(e));}finally{setLeaving(false);}}
  return <AuthCard testId="verification-required"><div className="auth-recovery-icon"><MailOutlined/></div><h1>验证邮箱，开启经营空间</h1><p>当前账号：<strong>{session?.user.email}</strong></p><p>请打开验证邮件中的链接，确认邮箱后返回这里继续。</p><EmailVerificationStatus showContinue/>{error&&<Alert type="error" showIcon message={error} style={{marginTop:16}}/>}<Button block type="text" loading={leaving} onClick={()=>void leave()} style={{marginTop:20}}>退出登录</Button></AuthCard>;
}
export function ForgotPassword({open,onClose,capabilities}:{open:boolean;onClose:()=>void;capabilities:AuthCapabilities|null}){
  const [busy,setBusy]=useState(false);const [sent,setSent]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{if(open){setSent(false);setError('');}},[open]);
  async function submit(values:{email:string}){setBusy(true);setError('');try{await api('/auth/password/forgot',{method:'POST',body:JSON.stringify({email:values.email.trim()})});setSent(true);}catch(e){setError(safeError(e));}finally{setBusy(false);}}
  return <Modal title="找回密码" open={open} onCancel={()=>{if(!busy)onClose();}} footer={null} maskClosable={!busy} destroyOnHidden><div data-testid="forgot-password-dialog">
    {!capabilities?.emailEnabled?<Alert type="info" showIcon message="当前未配置邮件服务" description="暂不能通过邮件找回密码，请联系管理员。"/>:sent?<><Alert type="success" showIcon message="找回申请已受理" description="如果该邮箱已注册且满足发送间隔，将收到密码重置邮件。请检查收件箱和垃圾邮件；未收到时可稍后重新申请。"/><Button block onClick={onClose} style={{marginTop:20}}>返回登录</Button></>:<><p>填写注册时使用的邮箱，我们将受理密码重置申请。</p><Form name="forgot-password" layout="vertical" onFinish={submit} disabled={busy}><Form.Item name="email" label="注册邮箱" rules={[{required:true,message:'请输入注册邮箱'},{type:'email',message:'请输入有效邮箱'}]}><Input autoComplete="email" maxLength={254} placeholder="name@example.com"/></Form.Item>{error&&<Alert type="error" showIcon message={error} style={{marginBottom:16}}/>}<Button type="primary" block htmlType="submit" loading={busy}>申请重置邮件</Button></Form></>}
  </div></Modal>;
}
export default function AuthLinkPage({kind}:{kind:AuthLinkKind}){
  const navigate=useNavigate();const {session,loading:sessionLoading,confirmEmail,resetPassword}=useStore();
  const [token,setToken]=useState(()=>readAuthLinkToken(kind));const [busy,setBusy]=useState(false);const [success,setSuccess]=useState(false);const [error,setError]=useState('');const inFlight=useRef(false);
  useEffect(()=>()=>forgetAuthLinkToken(token),[token]);
  async function verify(){if(inFlight.current||!token)return;inFlight.current=true;setBusy(true);setError('');try{await confirmEmail(token);setSuccess(true);setToken('');}catch(e){setError(safeError(e));}finally{inFlight.current=false;setBusy(false);}}
  async function reset(values:{newPassword:string}){if(inFlight.current||!token)return;inFlight.current=true;setBusy(true);setError('');try{await resetPassword(token,values.newPassword);setToken('');navigate('/login?reset=success',{replace:true});}catch(e){setError(safeError(e));}finally{inFlight.current=false;setBusy(false);}}
  const isVerify=kind==='verify-email';
  return <AuthCard testId={isVerify?'verify-email-page':'reset-password-page'}>
    {success?<Result status="success" title="邮箱验证成功" subTitle={session?'邮箱验证已更新。当前登录账号不会自动切换。':'请使用对应账号登录，继续进入经营空间。'} extra={<Button type="primary" onClick={()=>navigate(session?'/':'/login',{replace:true})}>{session&&!needsEmailVerification(session)?'进入工作台':session?'返回验证页':'前往登录'}</Button>}/>:!token?<Result status="warning" title="链接不完整或已离开当前页面" subTitle="请重新打开邮件中的完整链接。若链接已过期，可重新申请。" extra={<Button type="primary" onClick={()=>navigate('/login',{replace:true})}>返回登录</Button>}/>:<>
      <div className="auth-recovery-icon"><MailOutlined/></div><h1>{isVerify?'确认你的邮箱':'设置新密码'}</h1><p>{isVerify?'点击下方按钮确认邮箱归属。打开此页面不会自动完成验证。':'请为账号设置新的密码，完成后需重新登录。'}</p>
      {error&&<Alert type="error" showIcon message={error} style={{marginBottom:20}}/>}
      {isVerify?<Button type="primary" size="large" block disabled={sessionLoading} loading={busy} onClick={()=>void verify()}>确认验证邮箱</Button>:<Form name="reset-password" layout="vertical" onFinish={reset} disabled={busy||sessionLoading}><Form.Item name="newPassword" label="新密码" rules={[{required:true,message:'请输入新密码'},{min:12,message:'新密码至少 12 个字符'},{max:128,message:'新密码不能超过 128 个字符'}]}><Input.Password autoComplete="new-password" maxLength={128}/></Form.Item><Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[{required:true,message:'请确认新密码'},({getFieldValue})=>({validator:(_,v)=>v===getFieldValue('newPassword')?Promise.resolve():Promise.reject(new Error('两次输入的密码不一致'))})]}><Input.Password autoComplete="new-password" maxLength={128}/></Form.Item><Button type="primary" size="large" block htmlType="submit" loading={busy}>重置密码</Button></Form>}
      <Button type="link" disabled={busy} block onClick={()=>navigate('/login',{replace:true})} style={{marginTop:14}}>返回登录</Button>
    </>}
  </AuthCard>;
}
