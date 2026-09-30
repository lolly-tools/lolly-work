// SPDX-License-Identifier: MPL-2.0
/** Named table mapping, validation and atomic wall-time edits. */
import type { TableEditorSpec, TableFieldSpec } from '@lolly-tools/core';
import type { TableValue } from './inputs.ts';

const key = (value: string): string => value.trim().toLowerCase();

/** Named matches take precedence over any positional interpretation. */
export function tableField(column: string, spec: TableEditorSpec): TableFieldSpec | undefined {
  return spec.fields.find((field) =>
    [field.key, field.label, field.column ?? field.label, ...(field.aliases ?? [])].some(
      (name) => key(name) === key(column)
    )
  );
}

export function tableMapping(
  table: TableValue,
  spec: TableEditorSpec
): { columns: string[]; issues: string[] } {
  const columns = table.columns.map(
    (column) => tableField(column, spec)?.column ?? tableField(column, spec)?.label ?? column
  );
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(key(column))) issues.push(`Duplicate column: ${column}`);
    seen.add(key(column));
  }
  for (const field of spec.fields) {
    if (field.required && !columns.some((column) => tableField(column, spec)?.key === field.key))
      issues.push(`Missing column: ${field.label}`);
  }
  return { columns, issues };
}

/** Append aligns headings and retains unknown columns from both tables. */
export function appendTable(current: TableValue, incoming: TableValue): TableValue {
  const columns = [...current.columns];
  for (const column of incoming.columns)
    if (!columns.some((c) => key(c) === key(column))) columns.push(column);
  const project = (table: TableValue): string[][] =>
    table.rows.map((row) =>
      columns.map((column) => row[table.columns.findIndex((c) => key(c) === key(column))] ?? '')
    );
  return { columns, rows: [...project(current), ...project(incoming)] };
}

export function validTableDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function tableMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]),
    m = Number(match[2]);
  return (h < 24 && m < 60) || (h === 24 && m === 0) ? h * 60 + m : null;
}

/** Shift wall times together, with explicit end dates when midnight is crossed. */
export function shiftTable(
  table: TableValue,
  spec: TableEditorSpec,
  minutes: number,
  days: number,
  selected?: number
): TableValue {
  if (
    !Number.isInteger(minutes) ||
    !Number.isInteger(days) ||
    Math.abs(minutes) > 525600 ||
    Math.abs(days) > 3660
  )
    throw new Error('Choose whole minutes and days within ten years.');
  const columns = [...table.columns];
  const fields = columns.map((column) => tableField(column, spec));
  const rows = table.rows.map((row) => [...row]);
  rows.forEach((row, index) => {
    if (selected !== undefined && selected !== index) return;
    const dates = new Map<string, string>();
    fields.forEach((field, c) => {
      if (field?.editor === 'date' && row[c]) dates.set(field.key, row[c]!);
    });
    fields.forEach((field, c) => {
      if (field?.editor === 'date' && row[c]) {
        if (!validTableDate(row[c]!))
          throw new Error(`Row ${index + 1}: fix ${field.label} before shifting.`);
        row[c] = new Date(Date.parse(row[c]! + 'T00:00:00Z') + days * 86400000)
          .toISOString()
          .slice(0, 10);
      }
    });
    fields.forEach((field, c) => {
      if (field?.editor !== 'time' || !row[c]) return;
      const n = tableMinutes(row[c]!);
      const dateField = spec.fields.find((f) => f.key === field.dateField);
      const day = dates.get(field.dateField ?? '') || dates.values().next().value;
      if (n === null || !day || !validTableDate(day) || !dateField)
        throw new Error(`Row ${index + 1}: fix ${field.label} and its date before shifting.`);
      const next = new Date(Date.parse(day + 'T00:00:00Z') + (n + minutes + days * 1440) * 60000);
      row[c] = next.toISOString().slice(11, 16);
      let d = columns.findIndex((column) => tableField(column, spec)?.key === dateField.key);
      if (d < 0) {
        d = columns.length;
        columns.push(dateField.column ?? dateField.label);
        rows.forEach((r) => {
          r[d] = '';
        });
      }
      row[d] = next.toISOString().slice(0, 10);
    });
  });
  return { columns, rows: rows.map((row) => columns.map((_, c) => row[c] ?? '')) };
}
