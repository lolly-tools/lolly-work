// SPDX-License-Identifier: MPL-2.0
import type { InstanceConfig } from '../config/instance.ts';
import { projectFilesEnabled } from '../projects/files.ts';
import type { Role } from '../rbac/evaluate.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import type { Store, UserRecord, ProjectRecord } from '../store/types.ts';
import { destinationAvailableTo } from './destinations.ts';
import type { ConfigDeliveryDestination, DeliveryRecord } from './types.ts';

/** Recheck the original person's current authority, including after human review. */
export async function assertProjectDeliveryAccess(delivery: DeliveryRecord, destination: ConfigDeliveryDestination, deps: {
  config: InstanceConfig; store: Store;
  access(user: UserRecord, project: ProjectRecord): Promise<ProjectAccess>;
}): Promise<void> {
  if (!delivery.projectSource) return;
  const { projectId, fileId, checksum } = delivery.projectSource;
  const user = delivery.principal.startsWith('user:') ? await deps.store.getUser(delivery.principal.slice(5)) : null;
  const project = await deps.store.getProject(projectId), file = await deps.store.getProjectFile(fileId);
  if (!destination.projectFiles || !projectFilesEnabled(deps.config, deps.store) || !user || user.disabledAt || user.id.startsWith('svc_')
    || !destinationAvailableTo(destination, { userId: user.id, groups: user.groups, role: user.role as Role }, await deps.store.listGrants())
    || !project || !accessAtLeast(await deps.access(user, project), 'viewer')
    || !file?.ready || file.projectId !== projectId || file.checksum !== checksum) {
    throw new Error('Project file or destination access is no longer available; nothing was sent');
  }
}
