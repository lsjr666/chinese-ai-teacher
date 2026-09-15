import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { initTheme } from './theme.mjs';
import './styles.css';

// 主题要在首屏渲染前落到 <html> 上，否则深色模式会先白闪一下。
initTheme();

class AppErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) return <div className="render-error"><h1>页面显示异常</h1><p>请刷新页面后重试，电脑端服务仍在运行。</p><button onClick={() => window.location.reload()}>刷新页面</button></div>;
    return this.props.children;
  }
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

createRoot(document.getElementById('root')).render(
  <AppErrorBoundary><React.StrictMode><App /></React.StrictMode></AppErrorBoundary>,
);
