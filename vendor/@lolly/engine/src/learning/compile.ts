// SPDX-License-Identifier: MPL-2.0
import type {
  LearningBlock,
  LearningContent,
  LearningContentBlock,
  LearningFile,
  LearningModule,
} from '@lolly-tools/core/learning-v1';
import { checkLearningModule, learningPath, parseLearningModule } from './module.ts';

export interface LearningBytes {
  bytes: Uint8Array;
  mime: string;
}
export interface CompiledLearning {
  content: LearningContent;
  files: Record<string, Uint8Array>;
}
const extensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'text/plain': 'txt',
  'application/pdf': 'pdf',
};

/** Reject mislabeled files before a shell claims that required media is ready. */
function checkSignature(bytes: Uint8Array, mime: string): void {
  const at = (offset: number, text: string) =>
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  const starts = (...signature: number[]) => signature.every((n, i) => bytes[i] === n);
  const valid =
    mime === 'image/png'
      ? starts(137, 80, 78, 71, 13, 10, 26, 10)
      : mime === 'image/jpeg'
        ? starts(255, 216, 255)
        : mime === 'image/webp'
          ? at(0, 'RIFF') && at(8, 'WEBP')
          : mime === 'video/mp4' || mime === 'audio/mp4'
            ? at(4, 'ftyp')
            : mime === 'video/webm' || mime === 'audio/webm'
              ? starts(26, 69, 223, 163)
              : mime === 'audio/mpeg'
                ? at(0, 'ID3') || (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)
                : mime === 'audio/ogg'
                  ? at(0, 'OggS')
                  : mime === 'audio/wav'
                    ? at(0, 'RIFF') && at(8, 'WAVE')
                    : mime === 'application/pdf'
                      ? at(0, '%PDF-')
                      : mime === 'text/plain';
  if (!valid)
    throw new Error(`A required file does not match its ${mime} format. Replace or re-export it.`);
  if (mime === 'text/plain') new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Shells supply rendered, self-contained bytes and a SHA-256 implementation. */
export async function compileLearningModule(
  input: LearningModule,
  releaseId: string,
  resolve: (block: LearningBlock) => Promise<LearningBytes[]>,
  hash: (bytes: Uint8Array) => Promise<string>,
  onProgress?: (message: string) => void,
  options: { throwIfCancelled?: () => void; preview?: boolean } = {}
): Promise<CompiledLearning> {
  const checkCancelled = () => options.throwIfCancelled?.();
  checkCancelled();
  const module = parseLearningModule(input);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(releaseId))
    throw new Error('Invalid release identifier.');
  const failures = checkLearningModule(module).filter((f) => f.severity === 'error');
  if (failures.length && !options.preview)
    throw new Error(failures.map((f) => f.message).join(' '));
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  const add = async (bytes: Uint8Array, mime: string, ext: string): Promise<LearningFile> => {
    if (!bytes.length) throw new Error('A required content file is empty.');
    checkCancelled();
    const digest = await hash(bytes);
    checkCancelled();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('The content hash is invalid.');
    const path = learningPath(`media/${digest}.${ext}`);
    if (!files[path]) {
      total += bytes.length;
      if (total > 512 * 1024 * 1024)
        throw new Error(
          'This module exceeds the 512 MB local package limit. Split it into smaller modules.'
        );
      files[path] = bytes.slice();
    }
    return { path, mime, hash: digest, size: bytes.length };
  };
  const lessons: LearningContent['lessons'] = [];
  for (const lesson of module.lessons) {
    const blocks: LearningContentBlock[] = [];
    for (const block of lesson.blocks) {
      checkCancelled();
      onProgress?.(`Preparing ${lesson.title}`);
      const compiled: LearningContentBlock = {
        id: block.id,
        kind: block.kind,
        text: block.text,
        description: block.description,
        decorative: block.decorative,
        transcript: block.transcript,
      };
      if (options.preview && block.kind === 'text' && !block.text?.trim())
        compiled.previewIssue = 'This text block is empty. Add your explanation in the editor.';
      try {
        if (block.kind !== 'text') {
          let parts: LearningBytes[];
          try {
            parts = await resolve(block);
            checkCancelled();
          } catch (error) {
            throw new Error(
              `${lesson.title}: ${error instanceof Error ? error.message : 'The source could not be prepared.'}`
            );
          }
          if (!parts.length || (block.kind !== 'slides' && parts.length !== 1))
            throw new Error(`${lesson.title}: the source returned an unexpected number of files.`);
          compiled.files = [];
          for (const part of parts) {
            const mime = part.mime.split(';')[0]!.toLowerCase();
            const family = block.kind === 'slides' ? 'image' : block.kind;
            const extension = extensions[mime];
            if (
              !extension ||
              (family !== 'resource' && !mime.startsWith(`${family}/`)) ||
              (family === 'resource' && !['text/plain', 'application/pdf'].includes(mime))
            )
              throw new Error(
                `${lesson.title}: unsupported ${block.kind} format ${mime}. Export a supported media file first.`
              );
            checkSignature(part.bytes, mime);
            compiled.files.push(await add(part.bytes, mime, extension));
          }
        }
        if (block.captions?.trim()) {
          if (!/^WEBVTT(?:\s|$)/.test(block.captions.trimStart()))
            throw new Error(`${lesson.title}: captions must start with WEBVTT.`);
          compiled.captionFile = await add(
            new TextEncoder().encode(block.captions),
            'text/vtt',
            'vtt'
          );
        }
      } catch (error) {
        checkCancelled();
        if (!options.preview) throw error;
        compiled.previewIssue =
          error instanceof Error ? error.message : 'This content is unavailable.';
      }
      blocks.push(compiled);
    }
    lessons.push({
      id: lesson.id,
      title: lesson.title || 'Untitled lesson',
      required: lesson.required,
      sectionId: lesson.sectionId,
      blocks,
    });
  }
  return {
    content: {
      schemaVersion: 1,
      ...(options.preview ? { previewOnly: true as const } : {}),
      moduleId: module.id,
      releaseId,
      objectives: module.objectives,
      title: module.title || 'Untitled course',
      description: module.description,
      language: module.language,
      sections: module.sections,
      lessons,
      completion: module.completion,
    },
    files,
  };
}
