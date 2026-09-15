// 渲染冒烟测试：把 React 组件真的渲染一遍，抓「构建能过、一打开就白屏」这类运行时错误。
// Vite 的 ssrLoadModule 负责编译 JSX（Node 自己看不懂），renderToString 负责跑首屏渲染。
// 副作用（useEffect）不会执行，所以不会真的去请求后端。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import React from 'react';

let server;

before(async () => {
  server = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
});

after(async () => {
  await server?.close();
});

const load = (relativePath) => server.ssrLoadModule(relativePath);

// React 的 renderToString 会在「文本 + 插值」之间塞入 <!-- --> 注释节点，
// 例如「共识别出 <!-- -->2<!-- --> 道题」。断言前先剥掉这些注释，避免测试因标记而假失败。
const clean = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

test('主界面首屏能渲染出工作台、导航与主题控件', async () => {
  const { default: App } = await load('/src/App.jsx');
  const html = renderToString(React.createElement(App));
  assert.match(html, /学习工作台/);
  assert.match(html, /拍照搜题/);
  assert.match(html, /历史记录/);
  assert.match(html, /本地模型/);
  assert.match(html, /主题/);
  assert.match(html, /字号/);
  assert.doesNotMatch(html, /render-error/);
});

test('结果面板在无结果时给出空态，不抛错', async () => {
  const { ResultPanel } = await load('/src/result-view.jsx');
  const html = renderToString(React.createElement(ResultPanel, { mode: 'solve', result: null, results: [], busy: false }));
  assert.match(html, /分析结果会出现在这里/);
});

test('答案默认收起：参考答案区块首屏是折叠状态', async () => {
  const { SingleResult } = await load('/src/result-view.jsx');
  const html = renderToString(
    React.createElement(SingleResult, {
      mode: 'generate',
      result: { question: '1+1=?', referenceAnswer: '2', explanation: '基础加法', material: '一段材料' },
    }),
  );
  assert.match(html, /参考答案与解析/);
  assert.match(html, /展开查看/);
  assert.doesNotMatch(html, /collapsible is-open/);
  // 阅读材料与题目必须直接可见
  assert.match(html, /阅读材料/);
  assert.match(html, /一段材料/);
});

test('批改结论默认展开，得分环能渲染', async () => {
  const { SingleResult } = await load('/src/result-view.jsx');
  const html = renderToString(
    React.createElement(SingleResult, {
      mode: 'grade',
      result: { verdict: '思路正确', answer: 'x = 2', scorePercent: 92, steps: ['第一步'], mistakes: ['单位'], suggestions: ['检查单位'] },
    }),
  );
  assert.match(html, /本次得分/);
  assert.match(html, /思路正确/);
  assert.match(html, /改进建议/);
});

test('一图多题时每道题单独成卡', async () => {
  const { SingleResult } = await load('/src/result-view.jsx');
  const html = clean(
    renderToString(
      React.createElement(SingleResult, {
        mode: 'solve',
        result: {
          answer: '第一题',
          questions: [
            { index: 1, problemText: '1+1=?', answer: '2' },
            { index: 2, problemText: '2+2=?', answer: '4' },
          ],
        },
      }),
    ),
  );
  assert.match(html, /共识别出 2 道题/);
  assert.match(html, /第 1 题/);
  assert.match(html, /第 2 题/);
});

test('批量出题的结果渲染成一张卷子，并带导出与打印入口', async () => {
  const { ResultPanel } = await load('/src/result-view.jsx');
  const html = clean(
    renderToString(
      React.createElement(ResultPanel, {
        mode: 'generate',
        result: null,
        results: [
          { order: 1, questionType: '选择题', difficulty: '基础', knowledgePointNames: ['有理数'], question: '第 1 题题干', referenceAnswer: 'A' },
          { order: 2, questionType: '填空题', difficulty: '进阶', knowledgePointNames: ['整式'], question: '第 2 题题干', referenceAnswer: '3' },
        ],
        busy: false,
        // 真实使用中 App 一定会传入这些回调，工具栏按钮据此渲染；这里给桩函数贴近真实。
        onCopy: () => {},
        onExportWord: () => {},
        onPrint: () => {},
      }),
    ),
  );
  assert.match(html, /本次共生成 2 道题/);
  assert.match(html, /第 1 题/);
  assert.match(html, /选择题/);
  assert.match(html, /导出 Word/);
  assert.match(html, /打印/);
});

test('历史记录面板能渲染筛选与空态', async () => {
  const { HistoryPanel } = await load('/src/history-panel.jsx');
  const html = renderToString(React.createElement(HistoryPanel, { apiRequest: async () => ({ items: [], total: 0 }) }));
  assert.match(html, /搜过、出过、改过的题/);
  assert.match(html, /搜题/);
  assert.match(html, /出题/);
  assert.match(html, /批改/);
  assert.match(html, /回看结果/);
});
