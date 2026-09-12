import test from 'node:test';
import assert from 'node:assert/strict';
import { getKnowledgePoints, findKnowledgePoint } from './knowledge-points.mjs';

test('knowledge points cover all three stages and all supported subjects', () => {
  const points = getKnowledgePoints();
  const keys = new Set(points.map((point) => `${point.stage}:${point.subject}`));

  assert.equal(keys.size, 17);
  assert.ok(points.length >= 170);
  assert.ok(keys.has('小学:语文'));
  assert.ok(keys.has('初中:数学'));
  assert.ok(keys.has('高中:英语'));
  for (const stage of ['初中', '高中']) {
    for (const subject of ['物理', '化学', '生物', '地理']) {
      assert.ok(keys.has(`${stage}:${subject}`));
    }
  }
});

test('knowledge point lookup returns a stable point for question generation', () => {
  const point = findKnowledgePoint('primary-math-fractions');

  assert.equal(point.id, 'primary-math-fractions');
  assert.equal(point.subject, '数学');
  assert.equal(point.stage, '小学');
  assert.ok(point.examples.length > 0);
});
