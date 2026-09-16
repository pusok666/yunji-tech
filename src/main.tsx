import { Component, type ErrorInfo, type ReactNode } from 'react';
import '@ant-design/v5-patch-for-react-19';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, App as AntApp, Button, Result } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import { StoreProvider } from './store';
import './styles.css';
import './readability.css';
class ErrorBoundary extends Component<{children:ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return {failed:true};}componentDidCatch(error:Error,info:ErrorInfo){console.error('Yunji render error',error,info);}render(){return this.state.failed?<Result status="error" title="页面暂时遇到问题" subTitle="业务数据仍保存在浏览器中，请刷新重试。" extra={<Button type="primary" onClick={()=>location.reload()}>重新加载</Button>}/>:this.props.children;}}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><ConfigProvider locale={zhCN} theme={{token:{colorPrimary:'#2867ed',colorSuccess:'#1aa88d',colorText:'#28364d',colorTextSecondary:'#7d899e',colorBgLayout:'#f5f7fb',colorBorder:'#e4e9f1',fontFamily:'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',fontSize:14,borderRadius:8,controlHeight:36},components:{Button:{primaryShadow:'0 4px 10px rgba(40,103,237,.15)'},Table:{headerBg:'#f8faff',headerColor:'#8090a5',headerSplitColor:'transparent',cellPaddingBlock:17},Modal:{titleFontSize:19}}}}><AntApp><StoreProvider><App/></StoreProvider></AntApp></ConfigProvider></ErrorBoundary>);
