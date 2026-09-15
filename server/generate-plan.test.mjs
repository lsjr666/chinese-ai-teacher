import test from 'node:test';
import assert from 'node:assert/strict';
import { expandGeneratePlan, maxBatchQuestions, normalizeDifficulty } from './generate-plan.mjs';
import { getKnowledgePoints } from './knowledge-points.mjs';

const points = getKnowledgePoints();
const find = (stage, subject, name) => points.find((point) => point.stage === stage && point.subject === subject && point.name === name);

test('按题型配额展开成逐题清单', () => {
  const plan = expandGeneratePlan(
    {
      stage: '初中',
      subject: '数学',
      selections: [
        { knowledgePointIds: ['middle-math-1'], questionType: '选择题', difficulty: '基础', count: 3 },
        { knowledgePointIds: ['middle-math-2'], questionType: '解答题', difficulty: '进阶', count: 2 },
      ],
    },
    points,
  );
  assert.equal(plan.items.length, 5);
  assert.equal(plan.items.filter((item) => item.questionType === '选择题').length, 3);
  assert.equal(plan.items.filter((item) => item.questionType === '解答题').length, 2);
  assert.deepEqual(plan.items[0].knowledgePointNames, [find('初中', '数学', '有理数').name]);
  assert.deepEqual(plan.errors, []);
});

test('复合知识点把多个名字一起带给出题 prompt', () => {
  const plan = expandGeneratePlan(
    {
      stage: '初中',
      subject: '数学',
      selections: [{ knowledgePointIds: ['middle-math-3', 'middle-math-5'], questionType: '解答题', count: 1 }],
    },
    points,
  );
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].knowledgePointNames.length, 2);
});

test('非法题型被静默纠正并给出提示，而不是把矛盾要求交给模型', () => {
  const plan = expandGeneratePlan(
    { stage: '初中', subject: '数学', selections: [{ knowledgePointIds: ['middle-math-1'], questionType: '阅读题', count: 1 }] },
    points,
  );
  assert.notEqual(plan.items[0].questionType, '阅读题');
  assert.ok(plan.errors.some((message) => message.includes('不支持阅读题')));
});

test('选中的知识点不属于该学段学科时回落到第一个可用知识点', () => {
  const plan = expandGeneratePlan(
    { stage: '小学', subject: '语文', selections: [{ knowledgePointIds: ['middle-math-1'], questionType: '选择题', count: 1 }] },
    points,
  );
  assert.equal(plan.items[0].knowledgePointNames.length, 1);
  assert.equal(plan.items[0].knowledgePointIds[0].startsWith('primary-chinese'), true);
});

test('单次总量有上限，超出部分被截断并提示', () => {
  const plan = expandGeneratePlan(
    { stage: '初中', subject: '数学', selections: [{ knowledgePointIds: ['middle-math-1'], questionType: '选择题', count: 20 }] },
    points,
  );
  assert.equal(plan.items.length, maxBatchQuestions());
  assert.ok(plan.errors.some((message) => message.includes('一次最多生成')));
  const custom = expandGeneratePlan(
    { stage: '初中', subject: '数学', selections: [{ knowledgePointIds: ['middle-math-1'], questionType: '选择题', count: 20 }] },
    points,
    { maxTotal: 5 },
  );
  assert.equal(custom.items.length, 5);
});

test('数量为 0 的题型不参与展开，全为 0 时直接报错', () => {
  const plan = expandGeneratePlan(
    {
      stage: '高中',
      subject: '英语',
      selections: [
        { knowledgePointIds: ['high-english-1'], questionType: '选择题', difficulty: '基础', count: 1 },
        { knowledgePointIds: ['high-english-1'], questionType: '填空题', difficulty: '基础', count: 0 },
      ],
    },
    points,
  );
  assert.equal(plan.items.length, 1);
  assert.throws(
    () => expandGeneratePlan({ stage: '高中', subject: '英语', selections: [{ knowledgePointIds: ['high-english-1'], questionType: '选择题', count: 0 }] }, points),
    /至少选择/,
  );
});

test('缺学段学科或知识点时给出明确错误', () => {
  assert.throws(() => expandGeneratePlan({ stage: '', subject: '数学', selections: [{ count: 1 }] }, points), /学段和学科/);
  assert.throws(() => expandGeneratePlan({ stage: '小学', subject: '语文', selections: [] }, points), /至少选择/);
});

test('难度取值被约束在白名单内', () => {
  assert.equal(normalizeDifficulty('进阶'), '进阶');
  assert.equal(normalizeDifficulty('超纲'), '基础');
  assert.equal(normalizeDifficulty(undefined), '基础');
});
