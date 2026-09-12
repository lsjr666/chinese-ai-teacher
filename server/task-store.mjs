import { randomUUID } from 'node:crypto';

const tasks = new Map();
const taskTtlMs = 60 * 60 * 1000;

function cleanup() {
  const cutoff = Date.now() - taskTtlMs;
  for (const [id, task] of tasks) {
    if (task.updatedAt < cutoff) tasks.delete(id);
  }
}

export function createTask(work) {
  cleanup();
  const id = randomUUID().slice(0, 12);
  const task = { id, status: 'running', result: null, error: '', updatedAt: Date.now() };
  tasks.set(id, task);
  const promise = Promise.resolve().then(work).then((result) => {
    task.status = 'complete';
    task.result = result;
    task.updatedAt = Date.now();
    return result;
  }).catch((error) => {
    task.status = 'error';
    task.error = error?.message || '请求失败。';
    task.updatedAt = Date.now();
    return null;
  });
  return { id, promise };
}

export function getTaskSnapshot(id) {
  cleanup();
  const task = tasks.get(id);
  if (!task) return null;
  if (task.status === 'running') return { id: task.id, status: task.status };
  if (task.status === 'error') return { id: task.id, status: task.status, error: task.error };
  return { id: task.id, status: task.status, result: task.result };
}
