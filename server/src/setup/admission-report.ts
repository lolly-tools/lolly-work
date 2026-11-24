// SPDX-License-Identifier: MPL-2.0
/**
 * The Setup line for pod admission. A platform team that runs Kubewarden can
 * record what it answered about Work's pods (scripts/kubewarden-preflight.ts
 * --report) and mount the file; this turns the record into one check. Work has
 * no Kubernetes API access, so the check shows a dated record made by the
 * preflight and says that in its message. With no file configured, Setup
 * shows nothing.
 */
import { readFileSync, statSync } from 'node:fs';
import type { SetupCheck } from './checks.ts';

export const ADMISSION_REPORT_MAX_BYTES = 256 * 1024;
/** A record older than this is shown with a warning: the cluster may have changed since. */
export const ADMISSION_REPORT_STALE_DAYS = 90;

interface Recorded {
  checkedAt: string; namespace: string; version: string | null;
  policies: { active: boolean; enforcing: boolean }[]; pods: boolean[]; probes: boolean[]; ok: boolean;
}

const NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]{1,40})?$/;
const list = (value: unknown, max: number): Record<string, unknown>[] | null =>
  Array.isArray(value) && value.length <= max && value.every(item => item && typeof item === 'object' && !Array.isArray(item)) ? value : null;

/** Reads the fields the line needs and nothing else. Returns null for any other shape. */
export function parseAdmissionReport(text: string): Recorded | null {
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object' || doc.version !== 1 || doc.source !== 'kubewarden') return null;
  const checkedAt = typeof doc.checkedAt === 'string' && Number.isFinite(Date.parse(doc.checkedAt)) ? doc.checkedAt : null;
  const namespace = typeof doc.namespace === 'string' && NAME.test(doc.namespace) ? doc.namespace : null;
  const kubewarden = doc.kubewarden && typeof doc.kubewarden === 'object' ? doc.kubewarden as Record<string, unknown> : null;
  const policies = list(doc.policies, 200), pods = list(doc.pods, 50), probes = list(doc.probes, 50);
  if (!checkedAt || !namespace || !kubewarden || !policies || !pods || !probes || typeof doc.ok !== 'boolean') return null;
  const version = typeof kubewarden.version === 'string' && VERSION.test(kubewarden.version) ? kubewarden.version : null;
  return {
    checkedAt, namespace, version, ok: doc.ok,
    policies: policies.map(policy => ({ active: policy.active === true, enforcing: policy.mode === 'protect' })),
    pods: pods.map(pod => pod.admitted === true),
    probes: probes.map(probe => probe.refused === true && typeof probe.by === 'string' && probe.by.length > 0),
  };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The check for a parsed record. The counts are recomputed here; the record's own `ok` can only lower the result. */
export function admissionCheck(record: Recorded | null, now: number): SetupCheck {
  const id = 'pod-admission';
  if (!record) return { id, status: 'warning', message: 'The Kubewarden record could not be read. Write it again with scripts/kubewarden-preflight.ts --report and update the ConfigMap.' };
  const day = record.checkedAt.slice(0, 10);
  const active = record.policies.filter(policy => policy.active && policy.enforcing).length;
  const admitted = record.pods.filter(Boolean).length, refused = record.probes.filter(Boolean).length;
  const facts = [
    `${active} of ${count(record.policies.length, 'policy', 'policies')} active and enforcing`,
    `${admitted} of ${count(record.pods.length, 'Lolly Work pod', 'Lolly Work pods')} admitted`,
    record.probes.length ? `${refused} of ${count(record.probes.length, 'test pod', 'test pods')} refused` : 'no test pods sent',
  ].join(', ');
  const from = `Reported by Kubewarden${record.version ? ` ${record.version}` : ''} for namespace ${record.namespace} on ${day}: ${facts}.`;
  const record_ = 'This is the record your platform team made with the preflight, not a live reading.';
  const clean = record.ok && record.policies.length > 0 && active === record.policies.length
    && record.pods.length > 0 && admitted === record.pods.length && refused === record.probes.length;
  if (!clean) return { id, status: 'warning', message: `${from} The record is not clean. Run the preflight again and read its output.` };
  const ageDays = Math.floor((now - Date.parse(record.checkedAt)) / 86_400_000);
  if (ageDays > ADMISSION_REPORT_STALE_DAYS) {
    return { id, status: 'warning', message: `${from} The record is ${ageDays} days old. Run the preflight again after a cluster, chart or policy change.` };
  }
  return { id, status: 'pass', message: `${from} ${record_}` };
}

/** Null when no record is configured, so an install without Kubewarden shows nothing. */
export function podAdmissionCheck(env: Record<string, string | undefined> = process.env, now: number = Date.now()): SetupCheck | null {
  const file = env.LW_ADMISSION_REPORT_FILE?.trim();
  if (!file) return null;
  try {
    if (statSync(file).size > ADMISSION_REPORT_MAX_BYTES) return admissionCheck(null, now);
    return admissionCheck(parseAdmissionReport(readFileSync(file, 'utf8')), now);
  } catch {
    return admissionCheck(null, now);
  }
}
