// SPDX-License-Identifier: MPL-2.0
import type { LearningAttempt, LearningContent } from '@lolly-tools/core/learning-v1';

/** Self-contained so the exported player runs exactly this reducer. */
export function learningProgress(
  content: Pick<LearningContent, 'releaseId' | 'lessons'>,
  previous: unknown,
  action: {
    kind: 'open' | 'acknowledge' | 'finish' | 'restore' | 'answer';
    lessonId?: string;
    blockId?: string;
    answers?: string[];
  }
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
  const quizzes = content.lessons.flatMap((l) => l.blocks || []).filter((b) => b.quiz);
  const quizAnswers: Record<string, string[]> = {};
  for (const block of quizzes) {
    const answers =
      action.kind === 'answer' && action.blockId === block.id
        ? action.answers
        : same
          ? candidate.quizAnswers?.[block.id]
          : undefined;
    if (!Array.isArray(answers)) continue;
    const chosen = block.quiz!.options.filter((o) => answers.includes(o.id)).map((o) => o.id);
    if (chosen.length && (block.quiz!.mode === 'multiple' || chosen.length === 1))
      quizAnswers[block.id] = chosen;
  }
  const required = content.lessons.filter((l) => l.required);
  const ready = required.length > 0 && required.every((l) => acknowledged.includes(l.id));
  return {
    version: 1,
    releaseId: content.releaseId,
    lessonId,
    acknowledged,
    ...(quizzes.length ? { quizAnswers } : {}),
    completed: ready && ((same && candidate.completed === true) || action.kind === 'finish'),
  };
}

export function encodeLearningAttempt(
  content: Pick<LearningContent, 'releaseId' | 'lessons'>,
  attempt: LearningAttempt,
  limit = 4096
): string {
  const quizzes = content.lessons.flatMap((l) => l.blocks || []).filter((b) => b.quiz);
  const answers = quizzes
    .map((b) =>
      b
        .quiz!.options.reduce(
          (mask, o, i) => mask | (attempt.quizAnswers?.[b.id]?.includes(o.id) ? 1 << i : 0),
          0
        )
        .toString(16)
        .padStart(2, '0')
    )
    .join('');
  const data = JSON.stringify([
    1,
    content.releaseId,
    content.lessons.findIndex((l) => l.id === attempt.lessonId),
    content.lessons.map((l) => (attempt.acknowledged.includes(l.id) ? '1' : '0')).join(''),
    attempt.completed ? 1 : 0,
    ...(quizzes.length ? [answers] : []),
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
      const quizzes = content.lessons.flatMap((l) => l.blocks || []).filter((b) => b.quiz);
      const quizAnswers: Record<string, string[]> = {};
      if (
        typeof a[5] === 'string' &&
        a[5].length === quizzes.length * 2 &&
        /^[0-9a-f]*$/.test(a[5])
      )
        quizzes.forEach((b, i) => {
          const mask = parseInt(a[5].slice(i * 2, i * 2 + 2), 16);
          quizAnswers[b.id] = b.quiz!.options.filter((_o, j) => mask & (1 << j)).map((o) => o.id);
        });
      previous = {
        version: 1,
        releaseId: a[1],
        lessonId: content.lessons[a[2]]?.id,
        acknowledged: content.lessons.filter((_l, i) => a[3][i] === '1').map((l) => l.id),
        completed: a[4] === 1,
        quizAnswers,
      };
    }
  } catch {
    /* An absent or invalid bookmark starts a fresh attempt. */
  }
  return reduce(content, previous, { kind: 'restore' });
}
