import test from 'node:test';
import assert from 'node:assert/strict';
import { getRestoredTaskView } from '../client/src/task-state.mjs';

test('restoring a running task keeps its image visible while polling', () => {
  const savedTask = {
    taskId: 'task-123',
    mode: 'solve',
    image: { dataUrl: 'data:image/jpeg;base64,photo', name: 'photo.jpg' },
  };

  assert.deepEqual(getRestoredTaskView(savedTask), {
    mode: 'solve',
    image: savedTask.image,
    busy: true,
  });
});

test('a missing saved task starts on the normal empty solve view', () => {
  assert.deepEqual(getRestoredTaskView(null), {
    mode: 'solve',
    image: null,
    busy: false,
  });
});
