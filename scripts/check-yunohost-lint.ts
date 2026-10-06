// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface LintReport {
  success: string[];
  info: string[];
  warning: string[];
  error: string[];
  critical: string[];
}

/** Catalog publication is separate from checking this in-repo package. */
export function checkYunohostLint(value: unknown): { errors: string[]; publication: string[] } {
  if (!value || typeof value !== 'object') throw new Error('Missing YunoHost linter report.');
  const report = value as LintReport;
  for (const key of ['success', 'info', 'warning', 'error', 'critical'] as const) {
    if (!Array.isArray(report[key]) || !report[key].every((item) => typeof item === 'string')) {
      throw new Error('Invalid YunoHost linter report.');
    }
  }
  const publication = new Set(['AppCatalog.is_in_catalog', 'AppCatalog.state_is_working']);
  const failures = [...report.error, ...report.critical];
  return { errors: failures.filter((name) => !publication.has(name)), publication: failures.filter((name) => publication.has(name)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const path = process.argv[2];
    if (!path) throw new Error('Supply the official linter JSON report.');
    const result = checkYunohostLint(JSON.parse(readFileSync(path, 'utf8')));
    for (const name of result.publication) console.log(`YunoHost catalog publication pending: ${name}`);
    if (result.errors.length) {
      console.error(`YunoHost package lint failed: ${result.errors.join(', ')}`);
      process.exitCode = 1;
    } else console.log('YunoHost package checks passed; real package_check is still required.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cannot read YunoHost linter report.');
    process.exitCode = 1;
  }
}
