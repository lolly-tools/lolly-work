// SPDX-License-Identifier: MPL-2.0
/** Bounded lexical checks for the initial static emoji SVG subset. */
const scalar = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const numericToken = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
export const SVG_SCALAR_LIMIT = 1_000_000;

export function svgScalar(input: string, minimum = -SVG_SCALAR_LIMIT, maximum = SVG_SCALAR_LIMIT): string {
  const value = input.trim();
  const n = Number(value);
  if (!scalar.test(value) || !Number.isFinite(n) || n < minimum || n > maximum) throw new Error('Unsupported SVG number.');
  return String(n);
}

function tokens(input: string, commands: boolean): string[] {
  if (input.length > 400_000) throw new Error('SVG path exceeds the supported length.');
  const result: string[] = [];
  let offset = 0, comma = false;
  while (offset < input.length) {
    const char = input[offset]!;
    if (/[ \t\r\n]/.test(char)) { offset++; continue; }
    if (char === ',') {
      if (comma || !result.length || /^[a-z]$/i.test(result.at(-1)!)) throw new Error('Malformed SVG separator.');
      comma = true; offset++; continue;
    }
    if (commands && Object.hasOwn(arity, char.toUpperCase())) {
      if (comma) throw new Error('Malformed SVG separator.');
      result.push(char); offset++;
    } else {
      numericToken.lastIndex = offset;
      const match = numericToken.exec(input);
      if (!match) throw new Error('Unsupported SVG path or number list.');
      result.push(svgScalar(match[0])); offset = numericToken.lastIndex;
    }
    comma = false;
    if (result.length > 100_000) throw new Error('SVG exceeds the supported argument count.');
  }
  if (comma) throw new Error('Malformed SVG separator.');
  return result;
}

export function svgNumberList(value: string, lengths?: readonly number[]): string[] {
  const values = tokens(value, false);
  if (!values.length || (lengths && !lengths.includes(values.length))) throw new Error('Unsupported SVG number list.');
  return values;
}

/** Packed arc flags are deliberately unsupported in this subset; no partial path recovery. */
export function svgPath(value: string): string {
  const parts = tokens(value, true);
  if (!parts.length || !['M', 'm'].includes(parts[0]!)) throw new Error('SVG path must start with moveto.');
  let offset = 0, segments = 0;
  while (offset < parts.length) {
    const command = parts[offset++]!.toUpperCase();
    const count = arity[command];
    if (count === undefined) throw new Error('SVG path requires a command.');
    const start = offset;
    while (offset < parts.length && !/^[a-z]$/i.test(parts[offset]!)) offset++;
    const length = offset - start;
    if (count === 0 ? length !== 0 : length === 0 || length % count !== 0) throw new Error('Incomplete SVG path command.');
    if (command === 'A') {
      for (let index = start; index < offset; index += 7) {
        if (Number(parts[index]) < 0 || Number(parts[index + 1]) < 0 || !['0', '1'].includes(parts[index + 3]!) || !['0', '1'].includes(parts[index + 4]!)) throw new Error('Unsupported SVG arc arguments.');
      }
    }
    segments += count ? length / count : 1;
    if (segments > 10_000) throw new Error('SVG exceeds the supported segment count.');
  }
  return parts.join(' ');
}

export function svgTransform(value: string): string {
  const pattern = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)\s*/y;
  const counts: Record<string, number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
  const result: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(value);
    if (!match || result.length >= 64) throw new Error('Unsupported SVG transform.');
    const name = match[1]!;
    result.push(`${name}(${svgNumberList(match[2]!, counts[name]).join(' ')})`);
    offset = pattern.lastIndex;
    if (value[offset] === ',') offset++;
    if (offset === value.length && value.endsWith(',')) throw new Error('Malformed SVG transform separator.');
  }
  if (!result.length) throw new Error('Empty SVG transform.');
  return result.join(' ');
}
