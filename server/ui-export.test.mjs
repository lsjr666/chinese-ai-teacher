import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentHtml, escapeHtml, resultToPlainText } from '../client/src/export.mjs';
import { resolveTheme, readTheme, readScale } from '../client/src/theme.mjs';

const sample = {
  question: '阅读下文，回答问题。<1+1>',
  material: '小草偷偷地从土里钻出来。',
  options: ['A. 春季', 'B. 夏季'],
  figure: '矩形 ABCD，AB = 6。',
  referenceAnswer: '春季',
  steps: ['找到关键句。', '对应季节。'],
  translation: 'Spring.',
  explanation: '根据“偷偷地”判断。',
  knowledgePoints: ['散文阅读'],
};

test('导出的 Word 文档包含题目、原文、译文与答案', () => {
  const html = buildDocumentHtml({ title: '初中语文练习卷', subtitle: '初中 语文', results: [sample] });
  assert.match(html, /初中语文练习卷/);
  assert.match(html, /小草偷偷地从土里钻出来/);
  assert.match(html, /阅读材料/);
  assert.match(html, /春季/);
  assert.match(html, /Spring\./);
  assert.match(html, /A\. 春季/);
  assert.match(html, /图形说明/);
  assert.match(html, /@page/);
});

test('「仅题目」导出不含答案与解析', () => {
  const html = buildDocumentHtml({ title: '练习卷', results: [sample], includeAnswer: false });
  assert.match(html, /阅读下文/);
  assert.equal(html.includes('参考答案'), false);
  assert.equal(html.includes('Spring.'), false);
  assert.match(html, /仅题目/);
});

test('多道题按题号排开，题号连续', () => {
  const html = buildDocumentHtml({ title: '练习卷', results: [{ ...sample, order: 1 }, { ...sample, order: 2 }] });
  assert.match(html, /<h2>1\./);
  assert.match(html, /<h2>2\./);
});

test('HTML 转义杜绝题目里的尖括号破坏文档结构', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  const html = buildDocumentHtml({ title: 't', results: [sample] });
  assert.ok(!/<1\+1>/.test(html));
  assert.match(html, /&lt;1\+1&gt;/);
});

test('纯文本导出覆盖批改结果的关键字段', () => {
  const text = resultToPlainText({ verdict: '思路正确', scorePercent: 90, mistakes: ['单位漏写'], suggestions: ['检查单位'] });
  assert.match(text, /批改结论：思路正确/);
  assert.match(text, /单位漏写/);
  assert.match(text, /检查单位/);
});

test('主题偏好有默认值，系统主题在无浏览器环境下回落到浅色', () => {
  assert.equal(resolveTheme('light'), 'light');
  assert.equal(resolveTheme('dark'), 'dark');
  assert.equal(resolveTheme('system'), 'light');
  assert.equal(readTheme(), 'light');
  assert.equal(readScale(), 'normal');
});
