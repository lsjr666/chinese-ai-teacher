// 出题/解题结果的导出（需求 11）：先给「打印 / 存成 PDF」，再给「导出 Word」。
// 两条路都不引第三方库：打印走浏览器原生能力，Word 走「HTML 伪装成 .doc」这个
// Office 官方仍然支持的兼容格式，Word/WPS 都能直接打开并继续编辑。
const WORD_STYLE = `
  @page { size: A4; margin: 2cm 1.8cm; }
  body { font-family: "Microsoft YaHei", "Noto Sans SC", sans-serif; font-size: 11pt; line-height: 1.7; color: #1c1c1c; }
  h1 { font-size: 16pt; margin: 0 0 4px; }
  h2 { font-size: 13pt; margin: 18px 0 6px; }
  .meta { color: #666; font-size: 9pt; margin-bottom: 14px; }
  .question { font-size: 11.5pt; font-weight: 600; margin: 6px 0; }
  .material { background: #f5f5f5; border-left: 3px solid #999; padding: 8px 10px; margin: 6px 0; }
  .options div { margin: 2px 0 2px 12px; }
  .label { font-weight: 600; color: #333; margin-top: 10px; }
  .answer { border-left: 3px solid #4a8f6d; padding: 6px 10px; background: #f6faf6; }
  .steps ol { margin: 4px 0 0 18px; padding: 0; }
  .steps li { margin: 2px 0; }
  .tag { display: inline-block; border: 1px solid #bbb; border-radius: 3px; padding: 1px 6px; font-size: 9pt; color: #555; margin-right: 6px; }
  .divider { border-top: 1px dashed #bbb; margin: 20px 0; }
`;

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textToHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br />');
}

function listToHtml(items) {
  if (!items?.length) return '';
  return `<ol>${items.map((item) => `<li>${textToHtml(item)}</li>`).join('')}</ol>`;
}

export function resultToPlainText(result = {}) {
  const lines = [];
  if (result.question) lines.push(`题目：${result.question}`);
  if (result.material) lines.push(`阅读材料：${result.material}`);
  if (result.options?.length) lines.push(result.options.join('\n'));
  if (result.figure) lines.push(`图形说明：${result.figure}`);
  if (result.answer) lines.push(`答案：${result.answer}`);
  if (result.referenceAnswer) lines.push(`参考答案：${result.referenceAnswer}`);
  if (result.translation) lines.push(`参考译文：${result.translation}`);
  if (result.explanation) lines.push(`解析：${result.explanation}`);
  if (result.steps?.length) lines.push(`解题过程：\n${result.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`);
  if (result.keyIdeas?.length) lines.push(`关键思路：\n${result.keyIdeas.map((idea) => `- ${idea}`).join('\n')}`);
  if (result.verdict) lines.push(`批改结论：${result.verdict}`);
  if (result.mistakes?.length) lines.push(`问题：\n${result.mistakes.map((item) => `- ${item}`).join('\n')}`);
  if (result.suggestions?.length) lines.push(`建议：\n${result.suggestions.map((item) => `- ${item}`).join('\n')}`);
  if (result.knowledgePoints?.length) lines.push(`涉及知识点：${result.knowledgePoints.join('、')}`);
  return lines.join('\n\n');
}

function questionBlockHtml(result = {}, { index, includeAnswer = true } = {}) {
  const parts = [];
  const heading = index ? `${index}. ${result.questionType ? `（${escapeHtml(result.questionType)}）` : ''}` : '';
  if (heading) parts.push(`<h2>${heading}</h2>`);
  if (result.material) parts.push(`<div class="material"><div class="label">阅读材料</div>${textToHtml(result.material)}</div>`);
  parts.push(`<div class="question">${textToHtml(result.question || result.problemText || '')}</div>`);
  if (result.options?.length) parts.push(`<div class="options">${result.options.map((option) => `<div>${textToHtml(option)}</div>`).join('')}</div>`);
  if (result.figure) parts.push(`<div class="material"><div class="label">图形说明</div>${textToHtml(result.figure)}</div>`);
  if (includeAnswer) {
    const answer = result.referenceAnswer || result.answer;
    if (answer) parts.push(`<div class="label">参考答案</div><div class="answer">${textToHtml(answer)}</div>`);
    if (result.steps?.length) parts.push(`<div class="label">解题过程</div><div class="steps">${listToHtml(result.steps)}</div>`);
    if (result.translation) parts.push(`<div class="label">参考译文</div><div>${textToHtml(result.translation)}</div>`);
    if (result.explanation) parts.push(`<div class="label">解析</div><div>${textToHtml(result.explanation)}</div>`);
    if (result.knowledgePoints?.length) parts.push(`<div class="meta">涉及知识点：${result.knowledgePoints.map(escapeHtml).join('、')}</div>`);
  }
  return parts.join('\n');
}

export function buildDocumentHtml({ title = '中国人能教 · 导出内容', subtitle = '', results = [], includeAnswer = true } = {}) {
  const list = (Array.isArray(results) ? results : [results]).filter(Boolean);
  const body = list
    .map((item, index) => {
      const single = list.length === 1 && !item.order;
      return `<section>${questionBlockHtml(item, { index: single ? 0 : index + 1, includeAnswer })}</section>`;
    })
    .join('<div class="divider"></div>');
  const meta = [subtitle, includeAnswer ? '含答案与解析' : '仅题目（不含答案）', new Date().toLocaleString('zh-CN')]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title>
<style>${WORD_STYLE}</style></head>
<body><h1>${escapeHtml(title)}</h1><div class="meta">${meta}</div>${body}</body></html>`;
}

export function downloadBlob(filename, content, mime = 'application/octet-stream') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function safeFilename(name) {
  return String(name ?? 'export').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
}

// 导出为 Word 可打开的 .doc：带 Word 命名空间头，Word / WPS 都能直接编辑。
export function exportWord({ title = '中国人能教', filename, results, includeAnswer = true, subtitle = '' }) {
  const html = buildDocumentHtml({ title, subtitle, results, includeAnswer });
  const wordHtml = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8" /><title>${escapeHtml(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>${WORD_STYLE}</style></head>
<body>${html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'))}</body></html>`;
  downloadBlob(`${safeFilename(filename || title)}.doc`, `\ufeff${wordHtml}`, 'application/msword;charset=utf-8');
}

// 浏览器原生打印：打印样式表会把顶栏、侧边栏、按钮隐藏，只留题目与答案。
export function printPage() {
  window.print();
}
