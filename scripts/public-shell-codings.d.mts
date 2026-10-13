// SPDX-License-Identifier: MPL-2.0
export type CodingRequest = {
  version: number;
  source: string;
  candidate: string;
  previous: { path: string; sha256: string };
  scratch: string;
  models: { path: string; sha256: string };
  receipt: string;
};
export function prepareCodings(value: CodingRequest): Promise<Record<string, unknown>>;
