// SPDX-License-Identifier: MPL-2.0
import type { LearningModule, LearningTarget } from '@lolly-tools/core/learning-v1';
import { LEARNING_TARGETS } from './delivery.ts';

export interface LearningExportSettings {
  destination: string;
  maxMB: number;
}
/** Saving alone changes a revision, but must not invalidate a checked rendition. */
export function learningExportKey(
  module: LearningModule,
  target: LearningTarget,
  settings: LearningExportSettings
): string {
  return JSON.stringify([{ ...module, revision: 0 }, target, settings]);
}
export function checkLearningExportSize(bytes: number, maxMB: number): void {
  if (!Number.isFinite(maxMB) || maxMB < 0)
    throw new Error('Enter a positive upload limit or leave it at 0 for no destination limit.');
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error('The package is empty or has an invalid size.');
  if (maxMB && bytes > maxMB * 1_000_000)
    throw new Error(
      `The package is ${(bytes / 1_000_000).toFixed(2)} MB, above the ${maxMB} MB destination limit. Reduce media size or split the course, then check again.`
    );
}
export function learningHandoff(target: LearningTarget): string {
  if (!LEARNING_TARGETS.some((t) => t.id === target))
    throw new Error('Unsupported course destination.');
  if (target === 'static')
    return 'Extract the ZIP and upload all files together to an HTTP(S) website. Open index.html or embed that page in an iframe. Keep relative paths intact. Test navigation, media, completion and reopening in the intended browser. Progress is per course version, path and browser profile. No learner account, server record or cross-device resume is provided. Keep an existing version at its existing path to preserve its browser progress.';
  return `Import the unopened ZIP into a test course in your ${target === 'cmi5' ? 'cmi5-compatible' : target === 'tincan' ? 'Tin Can-compatible' : target === 'scorm2004' ? 'SCORM 2004 4th Edition-compatible' : 'SCORM 1.2-compatible'} LMS. Test launch, every media item, completion, close and resume, then assign learners. No score or pass mark is sent. Tenant compatibility still requires testing. ${['tincan', 'cmi5'].includes(target) ? 'This target is experimental; launch must supply learner identity, registration and temporary LRS authorization.' : ''} Customers choose when to replace an earlier package; replacing it can affect existing attempts according to the LMS.`;
}
