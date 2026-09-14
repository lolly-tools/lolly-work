// SPDX-License-Identifier: MPL-2.0
import type { LearningModule, LearningFinding } from '@lolly-tools/core/learning-v1';

export const LEARNING_LIMITS = {
  lessons: 200,
  blocks: 1000,
  text: 100_000,
  bytes: 16_000_000,
} as const;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const assetTypes = new Set([
  'vector',
  'raster',
  'video',
  'audio',
  'lottie',
  'model',
  'lut',
  'palette',
  'tokens',
  'font',
  'profile',
  'ratecard',
  'text',
  'data',
]);
const keys = (value: Record<string, unknown>, allowed: string) =>
  Object.keys(value).every((key) => allowed.split(' ').includes(key));
const kinds = new Set(['text', 'image', 'video', 'audio', 'resource', 'slides']);
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function text(v: unknown, max: number = LEARNING_LIMITS.text): v is string {
  return typeof v === 'string' && v.length <= max;
}
function id(v: unknown): v is string {
  return typeof v === 'string' && ID.test(v);
}

export function newLearningModule(
  moduleId: string,
  title = 'Learning module',
  language = 'en'
): LearningModule {
  return {
    schemaVersion: 1,
    id: moduleId,
    revision: 1,
    title,
    description: '',
    language,
    objectives: '',
    projectId: null,
    sections: [],
    lessons: [],
    completion: 'acknowledge-required',
  };
}

/** Validate persisted input before any shell resolves its sources. */
export function parseLearningModule(value: unknown): LearningModule {
  const bad = (): never => {
    throw new Error('This learning module is invalid or uses an unsupported version.');
  };
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !id(value.id) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  )
    return bad();
  if (
    !keys(
      value,
      'schemaVersion id revision title description language objectives projectId sections lessons completion'
    )
  )
    return bad();
  if (
    !text(value.title, 500) ||
    !text(value.description) ||
    !text(value.objectives) ||
    !text(value.language, 50) ||
    !/^[a-zA-Z0-9-]+$/.test(value.language)
  )
    return bad();
  if (value.projectId !== null && !text(value.projectId, 200)) return bad();
  if (
    value.completion !== 'acknowledge-required' ||
    !Array.isArray(value.sections) ||
    !Array.isArray(value.lessons) ||
    value.sections.length > 200 ||
    value.lessons.length > LEARNING_LIMITS.lessons
  )
    return bad();
  const ids = new Set<string>();
  const unique = (v: unknown): boolean => {
    if (!id(v) || ids.has(v)) return false;
    ids.add(v);
    return true;
  };
  const sections = new Set<string>();
  for (const section of value.sections) {
    if (
      !record(section) ||
      !unique(section.id) ||
      !text(section.title, 500) ||
      !keys(section, 'id title')
    )
      return bad();
    sections.add(String(section.id));
  }
  let blocks = 0;
  for (const lesson of value.lessons) {
    if (
      !record(lesson) ||
      !unique(lesson.id) ||
      !text(lesson.title, 500) ||
      typeof lesson.required !== 'boolean' ||
      !Array.isArray(lesson.blocks) ||
      !keys(lesson, 'id title required sectionId blocks')
    )
      return bad();
    if (lesson.sectionId !== undefined && !sections.has(String(lesson.sectionId))) return bad();
    for (const block of lesson.blocks) {
      if (
        ++blocks > LEARNING_LIMITS.blocks ||
        !record(block) ||
        !unique(block.id) ||
        !kinds.has(String(block.kind)) ||
        !keys(block, 'id kind text description decorative transcript captions source')
      )
        return bad();
      for (const key of ['text', 'description', 'transcript', 'captions'])
        if (block[key] !== undefined && !text(block[key])) return bad();
      if (block.decorative !== undefined && typeof block.decorative !== 'boolean') return bad();
      if (block.source !== undefined) {
        const s = block.source;
        if (
          !record(s) ||
          !['asset', 'session'].includes(String(s.kind)) ||
          !keys(s, 'kind asset slot toolId toolVersion values capturedAt pageIds motion')
        )
          return bad();
        if (
          s.kind === 'session' &&
          ((s.slot !== undefined && !text(s.slot, 500)) || !id(s.toolId) || !record(s.values))
        )
          return bad();
        if (s.kind === 'asset') {
          if (
            !record(s.asset) ||
            !text(s.asset.id, 2000) ||
            !text(s.asset.format, 40) ||
            typeof s.asset.url !== 'string' ||
            !assetTypes.has(String(s.asset.type)) ||
            !['library', 'user', 'remote'].includes(String(s.asset.source))
          )
            return bad();
        }
        if (s.toolVersion !== undefined && !text(s.toolVersion, 100)) return bad();
        if (s.capturedAt !== undefined && !text(s.capturedAt, 100)) return bad();
        if (
          s.pageIds !== undefined &&
          (!Array.isArray(s.pageIds) ||
            s.pageIds.length > 200 ||
            s.pageIds.some((p) => !text(p, 200)))
        )
          return bad();
        if (s.motion !== undefined && typeof s.motion !== 'boolean') return bad();
      }
    }
  }
  if (JSON.stringify(value).length > LEARNING_LIMITS.bytes)
    throw new Error('This learning module exceeds the document size limit.');
  return structuredClone(value) as unknown as LearningModule;
}

export function checkLearningModule(module: LearningModule): LearningFinding[] {
  parseLearningModule(module);
  const findings: LearningFinding[] = [];
  if (!module.title.trim())
    findings.push({ severity: 'error', message: 'Give the module a title.' });
  if (!module.lessons.some((l) => l.required))
    findings.push({ severity: 'error', message: 'Add at least one required lesson.' });
  for (const lesson of module.lessons) {
    const add = (severity: LearningFinding['severity'], message: string, blockId?: string) =>
      findings.push({ severity, message, lessonId: lesson.id, ...(blockId ? { blockId } : {}) });
    if (!lesson.title.trim()) add('error', 'Give this lesson a title.');
    if (!lesson.blocks.length) add('error', 'Add content to this lesson.');
    for (const block of lesson.blocks) {
      if (block.kind === 'text' && !block.text?.trim())
        add('error', 'Write the lesson text or remove the empty text.', block.id);
      if (block.kind !== 'text' && !block.source)
        add('error', 'Choose a source for this content.', block.id);
      if (
        ['image', 'slides'].includes(block.kind) &&
        !block.description?.trim() &&
        !block.decorative
      )
        add('review', 'Add an explanation for this visual content.', block.id);
      if (
        ['video', 'audio'].includes(block.kind) &&
        !block.transcript?.trim() &&
        !block.captions?.trim()
      )
        add('review', 'Review captions and a written alternative for this media.', block.id);
    }
  }
  return findings;
}

/** Strict package paths, including percent-encoded and Windows traversal. */
export function learningPath(path: string): string {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(path) ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error(`Invalid package path: ${path}`);
  return path;
}
