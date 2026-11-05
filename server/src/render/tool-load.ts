// SPDX-License-Identifier: MPL-2.0
/**
 * What a caller hears when a tool does not load.
 *
 * Node's filesystem errors carry the full path in their message
 * ("ENOENT: no such file or directory, open '/srv/pack/tools/x/tool.json'"), and how a
 * server lays out its disk is not a caller's business. So a missing tool is a stable
 * 404, any other filesystem failure is a plain sentence, and an engine refusal keeps its
 * own words, because those describe the tool. An id that could not name a tool directory
 * is refused before anything is read.
 */

const TOOL_ID = /^[a-z0-9][a-z0-9._-]*$/i;

export class ToolLoadRefusal extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ToolLoadRefusal';
    this.code = code;
    this.status = status;
  }
}

/** Roots an absolute server path starts with when it is not quoted, as in a stack frame.
 *  URL routes such as /api/v1/renders do not match, so a message can still name a route. */
const UNQUOTED_ROOTS = 'Users|home|root|srv|opt|var|tmp|private|app|usr|etc|mnt|data|workspace|run|Volumes|proc|pack';

/** Takes server paths out of a message bound for a caller. */
export function withoutServerPaths(message: string): string {
  return message
    .replace(/file:\/\/\S+/g, '[server path]')
    .replace(/(['"`])(?:\/|[A-Za-z]:[\\/])[^'"`]*\1/g, '$1[server path]$1')
    .replace(new RegExp(`(^|[\\s(=:])/(?:${UNQUOTED_ROOTS})(?:/[^\\s'"\`)]*)?`, 'g'), '$1[server path]')
    .replace(/(^|[\s(=:])[A-Za-z]:\\[^\s'"`)]*/g, '$1[server path]');
}

/** The refusal for one failed load. */
export function toolLoadRefusal(toolId: string, error: unknown): ToolLoadRefusal {
  if (error instanceof ToolLoadRefusal) return error;
  const e = error as { code?: unknown; syscall?: unknown; message?: unknown } | null;
  if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return new ToolLoadRefusal('TOOL_NOT_FOUND', 404, `No such tool: ${toolId}`);
  if (typeof e?.syscall === 'string') return new ToolLoadRefusal('TOOL_UNAVAILABLE', 500, `This server could not read tool "${toolId}".`);
  const detail = typeof e?.message === 'string' ? withoutServerPaths(e.message) : 'unknown error';
  return new ToolLoadRefusal('TOOL_LOAD_FAILED', 400, `Tool "${toolId}" failed to load: ${detail}`);
}

/** Runs a tool load, and turns every failure into a refusal a caller may read. */
export async function loadToolOrRefuse<T>(toolId: unknown, load: (toolId: string) => Promise<T>): Promise<T> {
  if (typeof toolId !== 'string') throw new ToolLoadRefusal('INVALID_INPUT', 400, 'toolId is required');
  if (!TOOL_ID.test(toolId)) throw new ToolLoadRefusal('TOOL_NOT_FOUND', 404, 'No such tool.');
  try { return await load(toolId); }
  catch (error) { throw toolLoadRefusal(toolId, error); }
}
