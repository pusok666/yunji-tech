import { useRef, useState } from 'react';
import { HashRouter, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Avatar, Button, Dropdown, Modal, Result, Spin, Tooltip, App as AntApp } from 'antd';
import { AppstoreOutlined, BarChartOutlined, BellOutlined, CloudOutlined, DownOutlined, DownloadOutlined, FileTextOutlined, InboxOutlined, LogoutOutlined, MenuOutlined, QuestionCircleOutlined, ReloadOutlined, SettingOutlined, TeamOutlined, ThunderboltOutlined, UploadOutlined, WalletOutlined } from '@ant-design/icons';
import { needsEmailVerification, useStore, type Backup } from './store';
import { metrics, today } from './lib/business';
import { mutationMessage } from './lib/mutationFeedback';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Records from './pages/Records';
import Statistics from './pages/Statistics';
import Assistant from './pages/Assistant';
import Settings from './pages/Settings';
import AuthLinkPage, { VerificationRequired } from './pages/AuthRecovery';
const nav=[{path:'/',title:'经营概览',icon:<AppstoreOutlined/>},{path:'/customers',title:'客户管理',icon:<TeamOutlined/>},{path:'/orders',title:'订单管理',icon:<FileTextOutlined/>},{path:'/inventory',title:'库存管理',icon:<InboxOutlined/>},{path:'/finance',title:'收支管理',icon:<WalletOutlined/>},{path:'/statistics',title:'数据统计',icon:<BarChartOutlined/>},{path:'/assistant',title:'AI 经营助手',icon:<ThunderboltOutlined/>},{path:'/settings',title:'空间设置',icon:<SettingOutlined/>}];
function Workspace(){
  const {message,modal}=AntApp.useApp();const location=useLocation();const navigate=useNavigate();
  const {data,session,error,ready,conflict,revision,refresh,logout,exportBackup,restore}=useStore();
  const [mobile,setMobile]=useState(false);const [help,setHelp]=useState(false);const [refreshing,setRefreshing]=useState(false);
  const file=useRef<HTMLInputElement>(null);const m=metrics(data);const current=nav.find(n=>n.path===location.pathname)?.title||'经营概览';
  async function reload(){setRefreshing(true);try{await refresh();message.success('已读取服务器最新数据');}catch(e){message.error((e as Error).message);}finally{setRefreshing(false);}}
  async function exportData(){try{const backup=await exportBackup();const url=URL.createObjectURL(new Blob([JSON.stringify(backup)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`云迹科技-经营备份-${today()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);message.success('备份已导出');}catch(e){message.error((e as Error).message);}}
  async function importData(selected?:File){
    if(!selected)return;
    try{
      if(selected.size>5*1024*1024)throw new Error('备份文件不能超过 5 MB');
      const parsed=JSON.parse(await selected.text()) as Backup;
      if(parsed?.format!=='yunji-commercial-backup'||parsed.version!==1||!parsed.data)throw new Error('请选择商业化版本导出的经营备份文件。');
      if(data.customers.length||data.orders.length||data.products.length||data.transactions.length||data.receipts?.length||data.stockMovements?.length)throw new Error('仅空工作空间可恢复备份，当前数据不会被覆盖。');
      modal.confirm({title:'将备份恢复到当前空工作空间？',content:'服务器将校验客户关联、收退款和库存流水。账号信息不会导入。',okText:'校验并恢复',cancelText:'取消',onOk:async()=>{try{const outcome=await restore(parsed);message.success(mutationMessage(outcome,'经营备份已恢复'));}catch(e){message.error((e as Error).message);throw e;}}});
    }catch(e){message.error((e as Error).message);}finally{if(file.current)file.current.value='';}
  }
  async function signOut(){try{await logout();navigate('/login');}catch(e){message.error((e as Error).message);}}
  return <div className="app-layout">
    {mobile&&<button className="sidebar-scrim" aria-label="关闭导航" onClick={()=>setMobile(false)}/>}
    <aside className={`sidebar ${mobile?'is-open':''}`}><NavLink className="brand" to="/"><img src="/favicon.svg" alt=""/><span>云迹科技<small>YUNJI TECHNOLOGY</small></span></NavLink>
      <div className="workspace-switch"><span className="workspace-avatar">{session?.workspace.name.slice(0,1)}</span><span><strong title={session?.workspace.name}>{session?.workspace.name}</strong><small>我的经营空间</small></span><span className="workspace-tag">TRIAL</span></div>
      <span className="nav-section-label">工作空间</span><nav>{nav.slice(0,6).map(n=><NavLink key={n.path} to={n.path} end={n.path==='/'} onClick={()=>setMobile(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}>{n.icon}<span>{n.title}</span>{n.path==='/inventory'&&m.lowStock.length>0&&<small className="nav-count">{m.lowStock.length}</small>}</NavLink>)}<div className="nav-separator"/><span className="nav-section-label">经营工具</span>{nav.slice(6).map(n=><NavLink key={n.path} to={n.path} onClick={()=>setMobile(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}>{n.icon}<span>{n.title}</span></NavLink>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-tip"><CloudOutlined/><strong>轻装上阵，专注经营</strong><p>让繁琐交给工具，<br/>把时间留给热爱的事业。</p><button onClick={()=>navigate('/assistant')}>遇见你的经营助手 <span>↗</span></button></div><div className="storage-status"><span className="live-dot"/>{error?'数据待同步':`服务器数据 · 版本 ${revision}`}<Tooltip title="记录成功保存后会同步到服务器；通过刷新按钮读取其他设备的最新操作。"><QuestionCircleOutlined/></Tooltip></div></div>
    </aside>
    <div className="main-layout"><header className="topbar"><div className="breadcrumb"><Button className="menu-toggle" type="text" icon={<MenuOutlined/>} aria-label="打开导航" onClick={()=>setMobile(true)}/><span>工作空间</span><span className="breadcrumb-divider">/</span><strong>{current}</strong></div>
      <div className="topbar-actions"><span className="demo-pill"><span/> 受邀试用</span><Tooltip title="读取服务器最新记录"><Button type="text" aria-label="刷新数据" loading={refreshing} icon={<ReloadOutlined/>} onClick={()=>void reload()}/></Tooltip><Tooltip title="经营待办"><Button type="text" aria-label="查看经营待办" icon={<BellOutlined/>} onClick={()=>navigate('/orders?filter=unpaid')}/></Tooltip><Button type="text" aria-label="使用帮助" icon={<QuestionCircleOutlined/>} onClick={()=>setHelp(true)}/><span className="topbar-separator"/>
        <Dropdown trigger={['click']} menu={{items:[{key:'settings',label:'空间设置与操作记录',icon:<SettingOutlined/>},{key:'export',label:'导出经营备份',icon:<DownloadOutlined/>},{key:'import',label:'恢复备份到空空间',icon:<UploadOutlined/>},{type:'divider'},{key:'logout',label:'退出工作台',icon:<LogoutOutlined/>}],onClick:({key})=>{if(key==='settings')navigate('/settings');if(key==='export')void exportData();if(key==='import')file.current?.click();if(key==='logout')void signOut();}}}><button className="account-button"><Avatar size={32} style={{background:'#eaf0ff',color:'#3f6fca'}}>{session?.user.name.slice(0,1)}</Avatar><span>{session?.user.name}</span><DownOutlined/></button></Dropdown>
      </div></header>
      <main className="main-content">{error&&<Alert type={conflict?'warning':'error'} showIcon message={error} action={<Button size="small" loading={refreshing} onClick={()=>void reload()}>刷新最新数据</Button>} style={{marginBottom:20}}/>}
        {!ready?<Result status="warning" title="经营数据尚未加载" subTitle="请检查服务连接后重试。" extra={<Button type="primary" loading={refreshing} onClick={()=>void reload()}>重新加载</Button>}/>:<Routes><Route path="/" element={<Dashboard/>}/><Route path="/customers" element={<Records key="customers" kind="customers"/>}/><Route path="/orders" element={<Records key="orders" kind="orders"/>}/><Route path="/inventory" element={<Records key="products" kind="products"/>}/><Route path="/finance" element={<Records key="transactions" kind="transactions"/>}/><Route path="/statistics" element={<Statistics/>}/><Route path="/assistant" element={<Assistant key={session?.workspace.id}/>}/><Route path="/settings" element={<Settings/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Routes>}
      </main>
    </div>
    <input type="file" accept="application/json,.json" ref={file} hidden onChange={e=>void importData(e.target.files?.[0])}/>
    <Modal title="欢迎使用云迹科技" open={help} onCancel={()=>setHelp(false)} footer={<Button type="primary" onClick={()=>setHelp(false)}>开始经营</Button>}><div className="help-content"><h3>从第一笔业务开始</h3><p>新增客户 → 创建订单 → 在订单中登记实际收款 → 查看收支和统计。商品与服务可通过订单业务分类区分。</p><h3>数据与协作</h3><p>记录保存在当前账号的服务器经营空间。其他设备操作后，点击顶部刷新读取最新数据。保存冲突时，请先刷新并核对表单。</p><h3>收支与库存口径</h3><p>经营日期统一按北京时间统计。收款、退款按各自实际发生日期统计；收支结余为现金流入减支出，不代表会计利润。库存通过出入库记录手工维护，订单不会自动扣库存。</p><h3>助手与备份</h3><p>经营助手使用服务器授权数据，回答会注明规则或模型模式。右上角可导出经营备份，备份只允许恢复到空工作空间。</p></div></Modal>
  </div>;
}
function AppRoutes(){
  const {session,loading}=useStore();const location=useLocation();
  const routeIdentity=useRef({signature:'',generation:0});
  const signature=location.pathname+'|'+location.search+'|'+location.key;
  if(routeIdentity.current.signature!==signature)routeIdentity.current={signature,generation:routeIdentity.current.generation+1};
  const waiting=<div className="session-loading"><Spin size="large"/><p>正在连接你的经营空间…</p></div>;
  return <Routes>
    <Route path="/verify-email" element={<AuthLinkPage key={routeIdentity.current.generation} kind="verify-email"/>}/>
    <Route path="/reset-password" element={<AuthLinkPage key={routeIdentity.current.generation} kind="reset-password"/>}/>
    <Route path="/login" element={loading?waiting:session?<Navigate to="/" replace/>:<Login/>}/>
    <Route path="*" element={loading?waiting:session?needsEmailVerification(session)?<VerificationRequired/>:<Workspace key={session.workspace.id}/>:<Navigate to="/login" replace/>}/>
  </Routes>;
}
export default function App(){return <HashRouter><AppRoutes/></HashRouter>;}
