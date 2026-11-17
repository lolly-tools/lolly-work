// Pure, DOM-free initials for an account's avatar. Kept in its own module so
// node:test can import it without a document. Browser + node ES module (served
// at /admin/initials.js by the console static handler).

/**
 * Up to two letters for an avatar.
 *
 * A name gives the first letter of each of its first two words. A qualifier in
 * brackets is not part of the name, so "Ada (Admin) Ops" is AO and never "A(".
 * Each word is read from its first letter or digit, so a quote or a dash in
 * front of a word never shows. An account with no name uses the part of its
 * email before the @, and the domain never supplies a letter.
 */
export function initialsOf(name, email) {
  const words = (text) => String(text ?? '')
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .split(/[\s.@_+-]+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean);
  const first = (word) => Array.from(word)[0] ?? '';
  const named = words(name);
  if (named.length >= 2) return (first(named[0]) + first(named[1])).toUpperCase();
  if (named.length === 1) return first(named[0]).toUpperCase();
  const local = words(String(email ?? '').split('@')[0]);
  if (local.length >= 2) return (first(local[0]) + first(local[1])).toUpperCase();
  if (local.length === 1) return Array.from(local[0]).slice(0, 2).join('').toUpperCase();
  return '?';
}
