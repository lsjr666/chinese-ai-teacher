export function getRestoredTaskView(savedTask) {
  if (!savedTask?.taskId || !savedTask.mode) {
    return { mode: 'solve', image: null, busy: false };
  }

  return {
    mode: savedTask.mode,
    image: savedTask.image ?? null,
    busy: true,
  };
}
