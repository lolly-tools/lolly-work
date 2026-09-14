// SPDX-License-Identifier: MPL-2.0
import type { LearningAttempt, LearningContent } from '@lolly-tools/core/learning-v1';

/** Self-contained so the exported player runs exactly this reducer. */
export function learningProgress(
  content: Pick<LearningContent, 'releaseId' | 'lessons'>,
  previous: unknown,
  action: { kind: 'open' | 'acknowledge' | 'finish' | 'restore'; lessonId?: string }
): LearningAttempt {
  const valid = new Set(content.lessons.map((l) => l.id));
  const candidate =
    previous && typeof previous === 'object' ? (previous as Partial<LearningAttempt>) : null;
  const same = candidate?.version === 1 && candidate.releaseId === content.releaseId;
  const acknowledged =
    same && Array.isArray(candidate.acknowledged)
      ? [...new Set(candidate.acknowledged.filter((id) => valid.has(id)))]
      : [];
  let lessonId =
    same && candidate.lessonId && valid.has(candidate.lessonId)
      ? candidate.lessonId
      : (content.lessons[0]?.id ?? '');
  if (action.lessonId && valid.has(action.lessonId)) {
    lessonId = action.lessonId;
    if (action.kind === 'acknowledge' && !acknowledged.includes(lessonId))
      acknowledged.push(lessonId);
  }
  const required = content.lessons.filter((l) => l.required);
  const ready = required.length > 0 && required.every((l) => acknowledged.includes(l.id));
  return {
    version: 1,
    releaseId: content.releaseId,
    lessonId,
    acknowledged,
    completed: ready && ((same && candidate.completed === true) || action.kind === 'finish'),
  };
}

export function encodeLearningAttempt(
  content: Pick<LearningContent, 'releaseId' | 'lessons'>,
  attempt: LearningAttempt,
  limit = 4096
): string {
  const data = JSON.stringify([
    1,
    content.releaseId,
    content.lessons.findIndex((l) => l.id === attempt.lessonId),
    content.lessons.map((l) => (attempt.acknowledged.includes(l.id) ? '1' : '0')).join(''),
    attempt.completed ? 1 : 0,
  ]);
  if (data.length > limit) throw new Error('Progress exceeds the selected LMS state limit.');
  return data;
}

export function decodeLearningAttempt(
  content: Pick<LearningContent, 'releaseId' | 'lessons'>,
  raw: string,
  reduce: typeof learningProgress = learningProgress
): LearningAttempt {
  let previous: unknown = null;
  try {
    const a = JSON.parse(raw);
    if (
      Array.isArray(a) &&
      a[0] === 1 &&
      a[1] === content.releaseId &&
      Number.isInteger(a[2]) &&
      typeof a[3] === 'string' &&
      a[3].length === content.lessons.length &&
      /^[01]*$/.test(a[3])
    ) {
      previous = {
        version: 1,
        releaseId: a[1],
        lessonId: content.lessons[a[2]]?.id,
        acknowledged: content.lessons.filter((_l, i) => a[3][i] === '1').map((l) => l.id),
        completed: a[4] === 1,
      };
    }
  } catch {
    /* An absent or invalid bookmark starts a fresh attempt. */
  }
  return reduce(content, previous, { kind: 'restore' });
}
