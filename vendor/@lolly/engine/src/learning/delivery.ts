// SPDX-License-Identifier: MPL-2.0
/** Portable course targets and source renditions, independent of a shell or provider. */
import type { LearningBlock, LearningModule, LearningTarget } from '@lolly-tools/core/learning-v1';

export const LEARNING_TARGETS: ReadonlyArray<{
  id: LearningTarget;
  label: string;
  description: string;
}> = [
  {
    id: 'static',
    label: 'Website',
    description:
      'Upload the extracted files to any static website. Progress stays in this browser.',
  },
  {
    id: 'scorm12',
    label: 'SCORM 1.2',
    description: 'For an LMS accepting SCORM 1.2. Test import, completion and resume.',
  },
  {
    id: 'scorm2004',
    label: 'SCORM 2004 4th Edition',
    description: 'Confirm support for this specific edition in the receiving LMS.',
  },
  {
    id: 'tincan',
    label: 'xAPI / Tin Can (experimental)',
    description:
      'Requires a compatible LMS launch with learner identity and temporary LRS authorization.',
  },
  {
    id: 'cmi5',
    label: 'cmi5 (experimental)',
    description: 'Requires a cmi5 launch. Separate from the Tin Can convention.',
  },
];
export interface LearningRendition {
  kind: LearningBlock['kind'];
  format: string;
  label: string;
}
export interface LearningRenderable {
  render?: { formats?: readonly string[]; export?: boolean; capture?: string };
  inputs?: readonly { type: string }[];
}
/** Select only declared outputs; a renderer must never silently fall back to another format. */
export function learningRenditions(manifest: LearningRenderable): LearningRendition[] {
  if (
    manifest.render?.capture ||
    manifest.render?.export === false ||
    manifest.inputs?.some((i) => i.type === 'file')
  )
    return [];
  const formats = manifest.render?.formats || [];
  const choices: LearningRendition[] = [];
  const add = (kind: LearningBlock['kind'], options: string[], label: string) => {
    const format = options.find((f) => formats.includes(f));
    if (format) choices.push({ kind, format, label });
  };
  add('slides', ['png', 'jpg', 'jpeg', 'webp'], 'Still pages');
  add('video', ['mp4', 'webm'], 'Video with motion');
  add('audio', ['mp3', 'wav', 'm4a', 'opus'], 'Audio');
  add('resource', ['pdf', 'txt'], 'Downloadable resource');
  return choices;
}
export function learningSummary(module: LearningModule) {
  const blocks = module.lessons.flatMap((l) => l.blocks);
  return {
    lessons: module.lessons.length,
    required: module.lessons.filter((l) => l.required).length,
    optional: module.lessons.filter((l) => !l.required).length,
    quizzes: blocks.filter((b) => b.kind === 'quiz').length,
    videos: blocks.filter((b) => b.kind === 'video').length,
    audio: blocks.filter((b) => b.kind === 'audio').length,
    resources: blocks.filter((b) => b.kind === 'resource').length,
    language: module.language,
    completion: 'Acknowledge every required lesson, then select Finish.',
  };
}
