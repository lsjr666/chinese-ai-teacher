import { useEffect, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Copy,
  Download,
  FileQuestion,
  Languages,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Printer,
  Shapes,
} from 'lucide-react';

export function MarkdownText({ value, className = '' }) {
  const source = String(value ?? '')
    .replace(/\\\(([^\n]*?)\\\)/g, '$$$1$$')
    .replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$')
    .replace(/#{3,}/g, '')
    .replace(/\*{2,}/g, '');
  const pieces = source.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);
  return (
    <div className={`markdown-text ${className}`}>
      {pieces.map((piece, index) => {
        const display = piece.startsWith('$$') && piece.endsWith('$$');
        const inline = piece.startsWith('$') && piece.endsWith('$');
        if (display || inline) {
          const formula = piece.slice(display ? 2 : 1, display ? -2 : -1);
          try {
            return (
              <span
                className={display ? 'math-block' : 'math-inline'}
                key={index}
                dangerouslySetInnerHTML={{
                  __html: katex.renderToString(formula, { displayMode: display, throwOnError: false, strict: false }),
                }}
              />
            );
          } catch {
            return <span key={index}>{piece}</span>;
          }
        }
        return <span key={index}>{piece}</span>;
      })}
    </div>
  );
}

export function ResultSection({ title, icon: Icon, children, tone = '', actions = null }) {
  return (
    <section className={`result-section ${tone}`}>
      <div className="result-section-title">
        <Icon size={17} />
        <span>{title}</span>
        {actions}
      </div>
      {children}
    </section>
  );
}

// 答案默认收起（需求 2）：让学生先自己写，点开再看。批改结论反过来，默认展开。
// 打印时由 CSS 强制展开，避免导出文档里答案「不见了」。
function CollapsibleSection({ title, icon: Icon, children, tone = 'answer-tone', defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  return (
    <section className={`result-section ${tone} collapsible ${open ? 'is-open' : ''}`}>
      <button type="button" className="collapse-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="result-section-title">
          <Icon size={17} />
          <span>{title}</span>
        </span>
        <span className="collapse-hint">{open ? '收起' : '展开查看'}<ChevronDown size={15} /></span>
      </button>
      <div className="collapsible-body">{children}</div>
    </section>
  );
}

function Steps({ list }) {
  if (!list?.length) return null;
  return (
    <ol className="step-list">
      {list.map((step, index) => (
        <li key={`${step}-${index}`}>
          <span>{index + 1}</span>
          <MarkdownText value={step} />
        </li>
      ))}
    </ol>
  );
}

function Bullets({ list }) {
  if (!list?.length) return null;
  return (
    <ul className="bullet-list">
      {list.map((item, index) => (
        <li key={`${item}-${index}`}>
          <MarkdownText value={item} />
        </li>
      ))}
    </ul>
  );
}

function MaterialBlock({ material }) {
  if (!material) return null;
  return (
    <ResultSection title="阅读材料" icon={BookOpen}>
      <div className="material-box">
        <MarkdownText value={material} />
      </div>
    </ResultSection>
  );
}

function FigureBlock({ figure }) {
  if (!figure) return null;
  return (
    <div className="figure-box">
      <span className="figure-label"><Shapes size={14} /> 图形说明</span>
      <MarkdownText value={figure} />
    </div>
  );
}

function TranslationBlock({ translation }) {
  if (!translation) return null;
  return (
    <div className="translation-box">
      <span className="figure-label"><Languages size={14} /> 参考译文</span>
      <MarkdownText value={translation} />
    </div>
  );
}

function Options({ list }) {
  if (!list?.length) return null;
  return (
    <div className="option-list">
      {list.map((option, index) => (
        <div key={`${option}-${index}`}>{option}</div>
      ))}
    </div>
  );
}

// 一张照片里的多道题（需求 4「同时搜多题」）
function SubQuestions({ list }) {
  if (!list?.length) return null;
  return (
    <div className="subquestion-list">
      <div className="result-section-title">
        <ListChecks size={17} />
        <span>这一页共识别出 {list.length} 道题</span>
      </div>
      {list.map((item) => (
        <div className="subquestion-card" key={`${item.index}-${item.problemText.slice(0, 12)}`}>
          <span className="subquestion-index">第 {item.index} 题</span>
          <MaterialBlock material={item.material} />
          <MarkdownText value={item.problemText} className="question-text" />
          <Options list={item.options} />
          <FigureBlock figure={item.figure} />
          <div className="subanswer">
            <span className="figure-label"><CheckCircle2 size={14} /> 答案</span>
            {item.answer ? <MarkdownText value={item.answer} className="answer-text" /> : <span className="muted-line">这一题没有返回答案。</span>}
            <Steps list={item.steps} />
            <TranslationBlock translation={item.translation} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SingleResult({ mode, result }) {
  if (!result) return null;
  const hasSub = result.questions?.length > 0;

  if (mode === 'generate') {
    return (
      <>
        <MaterialBlock material={result.material} />
        <ResultSection title="生成题目" icon={FileQuestion}>
          <MarkdownText value={result.question || result.answer} className="question-text" />
          <Options list={result.options} />
          <FigureBlock figure={result.figure} />
        </ResultSection>
        <CollapsibleSection title="参考答案与解析" icon={CheckCircle2} defaultOpen={false}>
          <MarkdownText value={result.referenceAnswer || result.answer} className="answer-text" />
          <Steps list={result.steps} />
          <TranslationBlock translation={result.translation} />
          {result.explanation && <MarkdownText value={result.explanation} />}
        </CollapsibleSection>
      </>
    );
  }

  return (
    <>
      {mode === 'grade' && (
        <div className="score-hero">
          <div>
            <span>本次得分</span>
            <strong>
              {result.scorePercent}
              <small>%</small>
            </strong>
          </div>
          <div className="score-ring" style={{ '--score': `${result.scorePercent * 3.6}deg` }}>
            <span>{result.scorePercent}</span>
          </div>
        </div>
      )}
      <MaterialBlock material={result.material} />
      {hasSub ? (
        <SubQuestions list={result.questions} />
      ) : (
        <ResultSection
          title={mode === 'grade' ? '批改结论' : '最终答案'}
          icon={mode === 'grade' ? ClipboardCheck : CheckCircle2}
          tone="answer-tone"
        >
          <MarkdownText value={mode === 'grade' ? result.verdict : result.answer} className="answer-text" />
          {mode === 'grade' && <MarkdownText value={result.answer} />}
          <TranslationBlock translation={result.translation} />
        </ResultSection>
      )}
      {result.steps?.length > 0 && (
        <CollapsibleSection title="解题过程" icon={ArrowRight} defaultOpen={mode === 'grade'}>
          <Steps list={result.steps} />
        </CollapsibleSection>
      )}
      {result.keyIdeas?.length > 0 && (
        <CollapsibleSection title="关键思路" icon={Lightbulb} defaultOpen={mode === 'grade'}>
          <Bullets list={result.keyIdeas} />
        </CollapsibleSection>
      )}
      {mode === 'grade' && (
        <ResultSection title="改进建议" icon={Lightbulb}>
          <Bullets list={[...(result.mistakes ?? []), ...(result.suggestions ?? [])]} />
        </ResultSection>
      )}
      {result.explanation && mode !== 'generate' && (
        <CollapsibleSection title="解析" icon={Lightbulb} defaultOpen={false}>
          <MarkdownText value={result.explanation} />
        </CollapsibleSection>
      )}
    </>
  );
}

function QuestionCard({ item, index, mode }) {
  return (
    <article className="paper-question">
      <div className="paper-question-head">
        <strong>第 {item.order ?? index + 1} 题</strong>
        <span className="paper-tags">
          {item.questionType && <em>{item.questionType}</em>}
          {item.difficulty && <em>{item.difficulty}</em>}
          {item.knowledgePointNames?.length > 0 && <em>{item.knowledgePointNames.join('、')}</em>}
        </span>
      </div>
      <SingleResult mode={mode} result={item} />
    </article>
  );
}

function Toolbar({ onCopy, onExportWord, onPrint, allowPlain }) {
  return (
    <div className="result-toolbar no-print">
      {onCopy && (
        <button className="ghost-button" type="button" onClick={onCopy}>
          <Copy size={15} /> 复制结果
        </button>
      )}
      {onExportWord && (
        <>
          <button className="ghost-button" type="button" onClick={() => onExportWord(true)}>
            <Download size={15} /> 导出 Word（含答案）
          </button>
          {allowPlain && (
            <button className="ghost-button" type="button" onClick={() => onExportWord(false)}>
              <Download size={15} /> 仅题目
            </button>
          )}
        </>
      )}
      {onPrint && (
        <button className="ghost-button" type="button" onClick={onPrint}>
          <Printer size={15} /> 打印 / 存成 PDF
        </button>
      )}
    </div>
  );
}

export function ResultPanel({ mode, result, results, busy, progress, onCopy, onExportWord, onPrint }) {
  if (busy) {
    return (
      <div className="result-empty is-loading">
        <LoaderCircle className="spin" size={27} />
        <strong>{progress ? `正在生成第 ${progress.done} / ${progress.total} 道题` : '模型正在推理'}</strong>
        <span>
          {progress
            ? '每完成一道就会出现在下面，中途不必刷新页面。'
            : '页面刷新后也会自动恢复，模型完成前不会返回空结果'}
        </span>
        {progress && (
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
          </div>
        )}
      </div>
    );
  }

  const list = Array.isArray(results) ? results : [];
  if (!result && !list.length) {
    return (
      <div className="result-empty">
        <div className="empty-orbit"><FileQuestion size={25} /></div>
        <strong>{mode === 'generate' ? '生成的题目会出现在这里' : '分析结果会出现在这里'}</strong>
        <span>{mode === 'grade' ? '上传作答照片，查看得分与改进建议' : '提交后将看到答案、过程和知识点'}</span>
      </div>
    );
  }

  const items = list.length ? list : [result];
  const knowledgePoints = [...new Set(items.flatMap((item) => item.knowledgePoints ?? []))];

  return (
    <div className={`result-content ${list.length ? 'is-paper' : ''}`}>
      <Toolbar onCopy={onCopy} onExportWord={onExportWord} onPrint={onPrint} allowPlain={list.length > 0} />
      {list.length > 1 && (
        <div className="paper-heading">
          <strong>本次共生成 {list.length} 道题</strong>
          <span>题号、题型与知识点见每题上方标签，导出后即可打印成一张练习卷。</span>
        </div>
      )}
      {list.length > 1 ? (
        list.map((item, index) => <QuestionCard item={item} index={index} mode={mode} key={`${item.order ?? index}-${index}`} />)
      ) : (
        <SingleResult mode={mode} result={items[0]} />
      )}
      {knowledgePoints.length > 0 && list.length === 1 && (
        <div className="knowledge-row">
          <span>涉及知识点</span>
          {knowledgePoints.map((point) => (
            <em key={point}>{point}</em>
          ))}
        </div>
      )}
    </div>
  );
}
