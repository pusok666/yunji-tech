import { useState } from 'react';
import { Alert, Button, Form, Input, Segmented, App as AntApp } from 'antd';
import { ArrowRightOutlined, LockOutlined, UserOutlined, CheckOutlined, RiseOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';

export default function Login() {
  const {message}=AntApp.useApp();const navigate=useNavigate();
  const {login,register,error,checkSession}=useStore();
  const [loading,setLoading]=useState(false);const [mode,setMode]=useState('login');
  async function submit(values:{email:string;password:string;name:string;workspaceName:string;inviteCode?:string}) {
    setLoading(true);
    try {if(mode==='login')await login({email:values.email.trim(),password:values.password});else await register({email:values.email.trim(),password:values.password,name:values.name.trim(),workspaceName:values.workspaceName.trim(),inviteCode:values.inviteCode?.trim()||undefined});navigate('/');}
    catch(e){message.error((e as Error).message);}finally{setLoading(false);}
  }
  return <main className="login-page">
    <section className="login-story"><a className="brand" href="#/login"><img src="/favicon.svg" alt=""/><span>云迹科技<small>YUNJI TECHNOLOGY</small></span></a>
      <div className="login-story-main"><span className="login-eyebrow">为每一个认真经营的人</span><h1>小团队，<br/>也有<span>大视野。</span></h1><p>从第一位客户，到下一次增长。<br/>让经营井然有序，让决策有迹可循。</p>
        <div className="login-visual"><div><span>经营的每一步，都在向上</span><RiseOutlined/></div><div className="visual-bars">{[26,42,35,58,47,69,63,82,76,95].map((v,i)=><i key={i} style={{height:`${v}%`}}/>)}</div><div className="visual-bottom"><span>记录</span><span>洞察</span><span>成长</span></div></div>
        <div className="login-benefits"><span><CheckOutlined/> 经营数据，一站掌握</span><span><CheckOutlined/> 独立空间，安心经营</span></div>
      </div><div className="login-copyright">© {new Date().getFullYear()} 云迹科技 · 智能经营管理平台</div>
    </section>
    <section className="login-form-area"><div className="login-form"><span className="login-badge">创业团队的轻量经营工作台</span><h2>{mode==='login'?'欢迎回到云迹':'创建你的经营空间'}</h2><p>{mode==='login'?'登录账号，继续经营。':'面向服务与商品业务，从第一条真实记录开始。'}</p>
      <Segmented block value={mode} disabled={loading} onChange={setMode} options={[{label:'账号登录',value:'login'},{label:'创建空间',value:'register'}]} style={{marginBottom:22}}/>
      {error&&<Alert type="error" showIcon message={error} action={<Button size="small" onClick={()=>void checkSession()}>重试连接</Button>} style={{marginBottom:16}}/>}
      <Form name={`auth-${mode}`} key={mode} layout="vertical" onFinish={submit} requiredMark={false} disabled={loading}>
        {mode==='register'&&<div className="form-two"><Form.Item name="name" label="你的姓名" rules={[{required:true,whitespace:true,message:'请输入姓名'}]}><Input autoComplete="name" maxLength={50}/></Form.Item><Form.Item name="workspaceName" label="经营空间名称" rules={[{required:true,whitespace:true,message:'请输入空间名称'}]}><Input placeholder="如：拾光工作室" maxLength={80}/></Form.Item></div>}
        <Form.Item name="email" label="邮箱" rules={[{required:true,message:'请输入邮箱'},{type:'email',message:'请输入有效邮箱'}]}><Input size="large" prefix={<UserOutlined/>} autoComplete="username" placeholder="name@example.com" maxLength={254}/></Form.Item>
        <Form.Item name="password" label="密码" rules={[{required:true,message:'请输入密码'},...(mode==='register'?[{min:12,message:'密码至少 12 个字符'}]:[])]}><Input.Password size="large" prefix={<LockOutlined/>} autoComplete={mode==='register'?'new-password':'current-password'} placeholder={mode==='register'?'至少 12 个字符':'请输入密码'} maxLength={128}/></Form.Item>
        {mode==='register'&&<><Form.Item name="confirmPassword" label="确认密码" dependencies={['password']} rules={[{required:true,message:'请再次输入密码'},({getFieldValue})=>({validator:(_,value)=>value===getFieldValue('password')?Promise.resolve():Promise.reject(new Error('两次输入的密码不一致'))})]}><Input.Password autoComplete="new-password" maxLength={128}/></Form.Item><Form.Item name="inviteCode" label="邀请码" extra="受邀试用时填写管理员提供的邀请码。"><Input placeholder="邀请码（如有）" autoComplete="off" maxLength={200}/></Form.Item></>}
        <Button type="primary" size="large" htmlType="submit" block loading={loading}>{mode==='login'?'登录工作台':'创建经营空间'} <ArrowRightOutlined/></Button>
      </Form>
      <div className="demo-notice"><strong>{mode==='login'?'账号与经营空间独立保存':'新空间从空白数据开始'}</strong><span>经营记录保存在服务器，同一账号可跨设备访问。<br/>{mode==='login'?'忘记密码时请联系空间管理员协助恢复。':'请妥善保管密码，并定期导出经营备份。'}</span></div>
    </div><div className="login-form-footer">专为一人公司、个体经营者和微型团队打造</div></section>
  </main>;
}
