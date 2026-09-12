import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, getTaskSnapshot } from './task-store.mjs';

test('background task exposes running state and then its result', async () => {
  const task = createTask(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { answer: 'x=2' };
  });

  assert.equal(getTaskSnapshot(task.id).status, 'running');
  await task.promise;

  assert.deepEqual(getTaskSnapshot(task.id), {
    id: task.id,
    status: 'complete',
    result: { answer: 'x=2' },
  });
});

test('background task exposes a visible error instead of disappearing', async () => {
  const task = createTask(async () => {
    throw new Error('math service failed');
  });

  await task.promise;

  assert.deepEqual(getTaskSnapshot(task.id), {
    id: task.id,
    status: 'error',
    error: 'math service failed',
  });
});
