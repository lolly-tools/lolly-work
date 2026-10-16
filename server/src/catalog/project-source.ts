// SPDX-License-Identifier: MPL-2.0
/** Read an immutable project file for catalog admission, checking every stored part. */
import { readBlobBody, type BlobStore } from '../blobs/types.ts';
import { fileChecksum, filePartBlobId, PROJECT_FILE_MAX_BYTES, type ProjectFileRecord } from '../projects/files.ts';
import { projectFilesEnabled } from '../projects/files.ts';
import type { InstanceConfig } from '../config/instance.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';

export interface ProjectSubmissionSource { projectId: string; fileId: string; checksum: string }

export class ProjectSubmissionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export async function projectSubmissionInput(query: URLSearchParams, d: {
  config: InstanceConfig; store: Store; blobs: BlobStore; user: UserRecord;
  currentUser(): Promise<UserRecord | null>;
  access(user: UserRecord, project: NonNullable<Awaited<ReturnType<Store['getProject']>>>): Promise<ProjectAccess>;
}) {
  const projectId = query.get('projectId'), fileId = query.get('fileId'), checksum = query.get('checksum');
  if (projectId === null && fileId === null && checksum === null) return null;
  if (!projectId || !fileId || !checksum || !/^[a-f0-9]{64}$/.test(checksum) || query.has('assetId') || query.has('type') || query.has('toolId')) {
    throw new ProjectSubmissionError(400, 'INVALID_INPUT', 'projectId, fileId and checksum select one original file for a new catalog submission');
  }
  if (!projectFilesEnabled(d.config, d.store)) throw new ProjectSubmissionError(404, 'NOT_FOUND', 'project files are off');
  if (d.user.id.startsWith('svc_')) throw new ProjectSubmissionError(403, 'FORBIDDEN', 'project files need a signed-in person');
  const source: ProjectSubmissionSource = { projectId, fileId, checksum };
  const stillReadable = async (): Promise<boolean> => {
    const user = await d.currentUser(), project = await d.store.getProject(projectId), file = await d.store.getProjectFile(fileId);
    return !!user && user.id === d.user.id && !user.disabledAt && !!project &&
      accessAtLeast(await d.access(user, project), 'viewer') && !!file?.ready && file.projectId === projectId && file.checksum === checksum;
  };
  if (!await stillReadable()) throw new ProjectSubmissionError(404, 'NOT_FOUND', 'project file is unavailable or changed');
  const file = (await d.store.getProjectFile(fileId))!;
  if (file.size > d.config.policy.submit.maxBytes) throw new ProjectSubmissionError(413, 'PAYLOAD_TOO_LARGE', 'project file exceeds policy.submit.maxBytes');
  let bytes: Buffer;
  try { bytes = await readProjectSubmission(file, d.blobs, d.config.policy.submit.maxBytes); }
  catch { throw new ProjectSubmissionError(422, 'SOURCE_UNAVAILABLE', 'project file could not be verified; nothing was submitted'); }
  return { source, bytes, contentType: file.contentType, stillReadable };
}

export async function readProjectSubmission(file: ProjectFileRecord, blobs: BlobStore, maxBytes: number): Promise<Buffer> {
  if (!file.ready || file.size < 1 || file.size > Math.min(maxBytes, PROJECT_FILE_MAX_BYTES)) throw new Error('Project file exceeds the submission limit');
  const parts: Buffer[] = [];
  let size = 0;
  for (let n = 0; n < file.parts.length; n++) {
    const expected = file.parts[n]!;
    if (expected.size < 1 || size + expected.size > file.size) throw new Error('Invalid project file parts');
    const part = await blobs.get(filePartBlobId(file, n));
    if (!part) throw new Error('Project file part is unavailable');
    const bytes = await readBlobBody(part.body, expected.size);
    if (bytes.length !== expected.size || fileChecksum(bytes) !== expected.checksum) throw new Error('Project file part failed verification');
    parts.push(bytes); size += bytes.length;
  }
  const bytes = Buffer.concat(parts, size);
  if (size !== file.size || fileChecksum(bytes) !== file.checksum) throw new Error('Project file failed verification');
  return bytes;
}
