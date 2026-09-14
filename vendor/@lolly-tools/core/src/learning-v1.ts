// SPDX-License-Identifier: MPL-2.0
import type { AssetRef } from './host-v1/asset-ref.ts';

export type LearningTarget = 'static' | 'scorm12' | 'scorm2004' | 'tincan' | 'cmi5';
/** Same-origin observation only. A receiving platform owns identity and durable records. */
export interface LearningProgressEventV1 {
  version: 1;
  moduleId: string;
  releaseId: string;
  lessonId: string;
  acknowledged: string[];
  completed: boolean;
  persistence: 'browser' | 'session';
}
export interface LearningSource {
  kind: 'asset' | 'session';
  asset?: AssetRef;
  slot?: string;
  toolId?: string;
  toolVersion?: string;
  values?: Record<string, unknown>;
  capturedAt?: string;
  pageIds?: string[];
  motion?: boolean;
}
export interface LearningBlock {
  id: string;
  kind: 'text' | 'image' | 'video' | 'audio' | 'resource' | 'slides';
  text?: string;
  description?: string;
  decorative?: boolean;
  transcript?: string;
  captions?: string;
  source?: LearningSource;
}
export interface LearningLesson {
  id: string;
  title: string;
  required: boolean;
  sectionId?: string;
  blocks: LearningBlock[];
}
export interface LearningModule {
  schemaVersion: 1;
  id: string;
  revision: number;
  title: string;
  description: string;
  language: string;
  objectives: string;
  projectId: string | null;
  sections: Array<{ id: string; title: string }>;
  lessons: LearningLesson[];
  completion: 'acknowledge-required';
}
export interface LearningFile {
  path: string;
  mime: string;
  hash: string;
  size: number;
}
export interface LearningContentBlock extends Omit<LearningBlock, 'source'> {
  files?: LearningFile[];
  captionFile?: LearningFile;
  /** Draft preview only; never allowed into a deliverable package. */
  previewIssue?: string;
}
/** Resolved presentation captured with a release, independent of later profile edits. */
export interface LearningPresentation {
  version: 1;
  colorScheme: 'light' | 'dark';
  tokens: Record<string, string>;
  fonts: Array<{
    family: string;
    weight: string;
    style: string;
    unicodeRange: string;
    file: LearningFile;
  }>;
  licenses: LearningFile[];
}
export interface LearningContent {
  schemaVersion: 1;
  previewOnly?: true;
  presentation?: LearningPresentation;
  moduleId: string;
  releaseId: string;
  objectives: string;
  title: string;
  description: string;
  language: string;
  sections: LearningModule['sections'];
  lessons: Array<Omit<LearningLesson, 'blocks'> & { blocks: LearningContentBlock[] }>;
  completion: LearningModule['completion'];
}
export interface LearningAttempt {
  version: 1;
  releaseId: string;
  lessonId: string;
  acknowledged: string[];
  completed: boolean;
}
export interface LearningFinding {
  severity: 'error' | 'review';
  message: string;
  lessonId?: string;
  blockId?: string;
}
export interface LearningRelease {
  id: string;
  createdAt: string;
  note: string;
  snapshot: LearningModule;
  content: LearningContent;
  files: Array<{ ref: AssetRef; path: string; hash: string }>;
  artifacts: Array<{
    target: LearningTarget;
    preset: string;
    filename: string;
    hash: string;
    asset: AssetRef;
  }>;
}
