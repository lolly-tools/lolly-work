// SPDX-License-Identifier: MPL-2.0
import type { LearningRichNode, LearningQuiz } from '@lolly-tools/core/learning-v1';

export function learningLinkAllowed(href: string): boolean {
  return (
    /^(https?:\/\/[^\s/]+|mailto:[^\s@]+@[^\s@]+)[^\s]*$/i.test(href) &&
    !Array.from(href).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
  );
}

/** Validate the semantic document before it reaches an editor or package. */
export function validLearningRichText(value: unknown): value is LearningRichNode {
  let count = 0,
    size = 0;
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, allowed: string[]) =>
    Object.keys(v).every((k) => allowed.includes(k));
  const blocks = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote'];
  const visit = (v: unknown, parent: string, depth: number): boolean => {
    if (
      !record(v) ||
      ++count > 10000 ||
      depth > 12 ||
      !keys(v, ['type', 'attrs', 'content', 'marks', 'text'])
    )
      return false;
    const type = String(v.type);
    const allowed =
      parent === ''
        ? ['doc']
        : ['paragraph', 'heading'].includes(parent)
          ? ['text', 'hardBreak']
          : ['bulletList', 'orderedList'].includes(parent)
            ? ['listItem']
            : blocks;
    if (!allowed.includes(type)) return false;
    if (v.text !== undefined && (type !== 'text' || typeof v.text !== 'string')) return false;
    if (type === 'text') {
      if (typeof v.text !== 'string' || !v.text.length) return false;
      size += v.text.length;
      if (size > 100000) return false;
    }
    if (v.attrs !== undefined) {
      if (!record(v.attrs)) return false;
      if (type === 'heading') {
        if (!keys(v.attrs, ['level']) || (v.attrs.level !== 2 && v.attrs.level !== 3)) return false;
      } else if (type === 'orderedList') {
        if (
          !keys(v.attrs, ['start']) ||
          !Number.isInteger(v.attrs.start) ||
          Number(v.attrs.start) < 1 ||
          Number(v.attrs.start) > 10000
        )
          return false;
      } else if (Object.keys(v.attrs).length) return false;
    } else if (type === 'heading') return false;
    if (v.marks !== undefined) {
      if (!['text', 'hardBreak'].includes(type) || !Array.isArray(v.marks) || v.marks.length > 5)
        return false;
      const seen = new Set();
      for (const mark of v.marks) {
        if (
          !record(mark) ||
          !keys(mark, ['type', 'attrs']) ||
          !['bold', 'italic', 'underline', 'code', 'link'].includes(String(mark.type)) ||
          seen.has(mark.type)
        )
          return false;
        seen.add(mark.type);
        if (mark.type === 'link') {
          if (
            !record(mark.attrs) ||
            !keys(mark.attrs, ['href', 'target', 'rel', 'class']) ||
            typeof mark.attrs.href !== 'string' ||
            !learningLinkAllowed(mark.attrs.href)
          )
            return false;
          for (const k of ['target', 'rel', 'class'])
            if (
              mark.attrs[k] !== undefined &&
              mark.attrs[k] !== null &&
              typeof mark.attrs[k] !== 'string'
            )
              return false;
        } else if (
          mark.attrs !== undefined &&
          (!record(mark.attrs) || Object.keys(mark.attrs).length)
        )
          return false;
      }
    }
    if (['text', 'hardBreak'].includes(type)) return v.content === undefined;
    if (v.content === undefined) return ['paragraph', 'heading', 'doc'].includes(type);
    if (!Array.isArray(v.content)) return false;
    if (['bulletList', 'orderedList', 'blockquote'].includes(type) && !v.content.length)
      return false;
    if (type === 'listItem' && (!v.content.length || v.content[0]?.type !== 'paragraph'))
      return false;
    return Array.from(v.content).every((child) => visit(child, type, depth + 1));
  };
  return visit(value, '', 0);
}

export function learningRichTextPlain(node: LearningRichNode): string {
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content || [])
    .map(learningRichTextPlain)
    .join(['paragraph', 'heading'].includes(node.type) ? '' : '\n');
}

export function validLearningQuiz(value: unknown): value is LearningQuiz {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const q = value as LearningQuiz;
  if (
    Object.keys(q).some((k) => !['mode', 'prompt', 'options', 'feedback'].includes(k)) ||
    !['single', 'multiple', 'true-false'].includes(q.mode) ||
    typeof q.prompt !== 'string' ||
    q.prompt.length > 10000 ||
    typeof q.feedback !== 'string' ||
    q.feedback.length > 10000 ||
    !Array.isArray(q.options) ||
    q.options.length < 2 ||
    q.options.length > 8 ||
    (q.mode === 'true-false' && q.options.length !== 2)
  )
    return false;
  const ids = new Set();
  return Array.from(q.options).every((o) => {
    if (
      !o ||
      typeof o !== 'object' ||
      Object.keys(o).some((k) => !['id', 'text', 'correct'].includes(k)) ||
      typeof o.id !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(o.id) ||
      ids.has(o.id) ||
      typeof o.text !== 'string' ||
      o.text.length > 2000 ||
      typeof o.correct !== 'boolean'
    )
      return false;
    ids.add(o.id);
    return true;
  });
}

/** Practice feedback only; this does not change course completion or LMS scores. */
export function learningQuizCorrect(quiz: LearningQuiz, answers: string[]): boolean {
  const chosen = new Set(answers);
  return (
    chosen.size > 0 &&
    answers.every((id) => quiz.options.some((o) => o.id === id)) &&
    quiz.options.every((option) => chosen.has(option.id) === option.correct)
  );
}
