// 批量出题（含「一次出一张卷子」）的计划展开：把前端的「题型配额」翻译成一份逐题的生成清单。
// 放在服务端做，是因为这里同时承担校验职责：
//  - 知识点必须属于所选学段学科；
//  - 题型必须在该（多）知识点的白名单交集内，否则回落到交集首项（需求 1）；
//  - 复合知识点最多 3 个（需求 3）；
//  - 单次总量有上限，避免一次点下去把电脑端堵死几十分钟（需求 10）。
import { intersectQuestionTypes, resolveQuestionType } from './knowledge-points.mjs';

export const MAX_POINTS_PER_QUESTION = 3;
export const MAX_QUESTIONS_PER_SELECTION = 20;

export function maxBatchQuestions(environment = process.env) {
  const configured = Number(environment.GENERATE_MAX_BATCH);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 12;
}

function toIdList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean);
  const single = String(value ?? '').trim();
  return single ? [single] : [];
}

export function normalizeDifficulty(value, allowed = ['基础', '进阶', '挑战']) {
  const text = String(value ?? '').trim();
  return allowed.includes(text) ? text : allowed[0];
}

// selections: [{ knowledgePointIds?, knowledgePointId?, questionType, difficulty, count }]
// 返回 { items, errors }：items 是逐题清单（同一组合按 count 展开），errors 是可展示给用户的提示。
export function expandGeneratePlan(input = {}, points = [], options = {}) {
  const stage = String(input.stage ?? '').trim();
  const subject = String(input.subject ?? '').trim();
  const selections = Array.isArray(input.selections) ? input.selections : [];
  const errors = [];
  const items = [];

  if (!stage || !subject) throw new Error('请选择学段和学科。');
  const pool = points.filter((point) => point.stage === stage && point.subject === subject);
  if (!pool.length) throw new Error('该学段学科下没有可选知识点。');
  if (!selections.length) throw new Error('请至少选择一种题型的出题数量。');

  for (const selection of selections) {
    const count = Math.max(0, Math.floor(Number(selection?.count) || 0));
    if (!count) continue;
    const rawIds = toIdList(selection.knowledgePointIds ?? selection.knowledgePointId);
    let chosen = rawIds.map((id) => pool.find((point) => point.id === id)).filter(Boolean);
    if (!chosen.length) chosen = [pool[0]];
    if (chosen.length > MAX_POINTS_PER_QUESTION) {
      errors.push(`单个题目的知识点最多 ${MAX_POINTS_PER_QUESTION} 个，已只取前 ${MAX_POINTS_PER_QUESTION} 个。`);
      chosen = chosen.slice(0, MAX_POINTS_PER_QUESTION);
    }
    const allowed = intersectQuestionTypes(chosen);
    const questionType = resolveQuestionType({ questionTypes: allowed }, selection.questionType);
    const requested = String(selection.questionType ?? '').trim();
    if (requested && requested !== questionType) {
      errors.push(`“${chosen.map((point) => point.name).join('、')}”不支持${requested}，已改为${questionType}。`);
    }
    const perSelection = Math.min(count, MAX_QUESTIONS_PER_SELECTION);
    if (perSelection < count) {
      errors.push(`单种题型一次最多 ${MAX_QUESTIONS_PER_SELECTION} 道，已按上限生成。`);
    }
    for (let index = 0; index < perSelection; index += 1) {
      items.push({
        knowledgePointIds: chosen.map((point) => point.id),
        knowledgePointNames: chosen.map((point) => point.name),
        questionType,
        difficulty: normalizeDifficulty(selection.difficulty),
      });
    }
  }

  if (!items.length) throw new Error('请至少选择一种题型的出题数量。');

  const limit = options.maxTotal ?? maxBatchQuestions(options.environment ?? process.env);
  if (items.length > limit) {
    errors.push(`一次最多生成 ${limit} 道题，超出部分已自动取消（可以分批生成，或在 .env 里调大 GENERATE_MAX_BATCH）。`);
    items.length = limit;
  }
  return { items, errors };
}
