// SPDX-License-Identifier: MPL-2.0
/**
 * Allowlist classifier for migration files.
 *
 * A file is `additive` only when every statement in it is one of:
 *   - CREATE TABLE of a name no earlier migration created;
 *   - ALTER TABLE ... ADD COLUMN that is nullable or has a constant default;
 *   - a non-unique CREATE INDEX on a table created earlier in the same file;
 *   - COMMENT ON ... IS ...
 * Everything else is `maintenance`: constraints, unique indexes, triggers,
 * functions, CREATE OR REPLACE, GRANT and REVOKE, data changes, DROP, RENAME,
 * column type changes and any statement or clause the parser does not
 * recognise. The class is computed from the SQL text only; a comment in the
 * file never sets it.
 *
 * Why: an additive file leaves every write the previous release makes valid, so
 * that release can keep serving (or be rolled back to) on the migrated schema.
 * A constraint, a unique index or a trigger can refuse the previous release's
 * writes, and a replaced function can quietly change behaviour (migration 0034
 * guards the audit log with one). Those need a person to decide.
 *
 * A foreign key from a new table to an existing table restricts deletes from
 * the existing table, so it is additive only with ON DELETE CASCADE, or with
 * ON DELETE SET NULL on a nullable column, and no ON UPDATE clause. Work never
 * updates a primary key, so the default ON UPDATE NO ACTION cannot refuse one
 * of its writes.
 *
 * The parser is deliberately small. Anything it cannot read, including SQL it
 * cannot tokenize, makes the file `maintenance`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readMigrationFiles } from './migrate.ts';

export type MigrationClass = 'additive' | 'maintenance';

export interface StatementVerdict {
  /** Position of the statement in the file, from 1. */
  index: number;
  /** create-table, create-index, add-column, comment or other. */
  kind: string;
  class: MigrationClass;
  /** Why the statement is maintenance; empty for an additive statement. */
  reason: string;
  /** The start of the statement, whitespace collapsed, for review output. */
  excerpt: string;
}

export interface SqlVerdict {
  class: MigrationClass;
  reasons: string[];
  statements: StatementVerdict[];
  /** Table names the file creates, whatever its class. */
  createdTables: string[];
}

export interface MigrationVerdict extends SqlVerdict {
  name: string;
  sha256: string;
}

/** Tables that exist although no migration file creates them. */
const RESERVED_TABLES = ['schema_migrations'];

// ---------------------------------------------------------------------------
// Tokenizer (PostgreSQL lexical rules, the parts migrations use)

type TokenKind = 'word' | 'quoted' | 'string' | 'number' | 'punct' | 'op' | 'dollar' | 'param';

interface Token {
  kind: TokenKind;
  /** Lower-cased for words, unquoted for quoted identifiers, the body for strings. */
  value: string;
  start: number;
  end: number;
}

class SqlSyntaxError extends Error {}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const OP_CHARS = '+-*/<>=~!@#%^&|`?';

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  const push = (kind: TokenKind, value: string, start: number, end: number) => { tokens.push({ kind, value, start, end }); };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      i = eol < 0 ? n : eol + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      // Block comments nest in PostgreSQL.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      if (depth > 0) throw new SqlSyntaxError('unterminated block comment');
      i = j;
      continue;
    }
    if (c === "'") {
      const [value, end] = readQuoted(sql, i, "'", false);
      push('string', value, i, end);
      i = end;
      continue;
    }
    if ((c === 'e' || c === 'E') && next === "'") {
      const [value, end] = readQuoted(sql, i + 1, "'", true);
      push('string', value, i, end);
      i = end;
      continue;
    }
    if ((c === 'u' || c === 'U') && next === '&') throw new SqlSyntaxError('Unicode escape literals are not supported');
    if (c === '"') {
      const [value, end] = readQuoted(sql, i, '"', false);
      if (!value) throw new SqlSyntaxError('empty quoted identifier');
      push('quoted', value, i, end);
      i = end;
      continue;
    }
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        if (close < 0) throw new SqlSyntaxError('unterminated dollar-quoted string');
        push('dollar', sql.slice(i + tag[0].length, close), i, close + tag[0].length);
        i = close + tag[0].length;
        continue;
      }
      const param = /^\$\d+/.exec(sql.slice(i));
      if (param) { push('param', param[0], i, i + param[0].length); i += param[0].length; continue; }
      throw new SqlSyntaxError('unexpected "$"');
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j]!)) j++;
      push('word', sql.slice(i, j).toLowerCase(), i, j);
      i = j;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && next !== undefined && /\d/.test(next))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(i))!;
      push('number', m[0], i, i + m[0].length);
      i += m[0].length;
      continue;
    }
    if (c === ':' && next === ':') { push('punct', '::', i, i + 2); i += 2; continue; }
    if ('(),;[].:'.includes(c)) { push('punct', c, i, i + 1); i++; continue; }
    if (OP_CHARS.includes(c)) {
      let j = i;
      while (j < n && OP_CHARS.includes(sql[j]!) && !(sql[j] === '-' && sql[j + 1] === '-') && !(sql[j] === '/' && sql[j + 1] === '*')) j++;
      push('op', sql.slice(i, j), i, j);
      i = j;
      continue;
    }
    throw new SqlSyntaxError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

/** Read a quoted run starting at `start` (the opening quote). A doubled quote
 *  is an escaped quote; with `backslash`, a backslash escapes the next character. */
function readQuoted(sql: string, start: number, quote: string, backslash: boolean): [string, number] {
  let value = '';
  let j = start + 1;
  for (;;) {
    if (j >= sql.length) throw new SqlSyntaxError(quote === '"' ? 'unterminated quoted identifier' : 'unterminated string');
    const ch = sql[j]!;
    if (backslash && ch === '\\') {
      if (j + 1 >= sql.length) throw new SqlSyntaxError('unterminated string');
      value += sql[j + 1];
      j += 2;
      continue;
    }
    if (ch === quote) {
      if (sql[j + 1] === quote) { value += quote; j += 2; continue; }
      return [value, j + 1];
    }
    value += ch;
    j++;
  }
}

function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === ';') {
      if (current.length) statements.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length) statements.push(current);
  return statements;
}

// ---------------------------------------------------------------------------
// Parser helpers

/** Thrown inside a statement check: the statement is maintenance, for this reason. */
class Maintenance extends Error {}

class Cursor {
  i = 0;
  readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  get done(): boolean { return this.i >= this.tokens.length; }
  peek(offset = 0): Token | undefined { return this.tokens[this.i + offset]; }

  isWord(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.kind === 'word' && t.value === word;
  }

  isPunct(punct: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.kind === 'punct' && t.value === punct;
  }

  acceptWord(...words: string[]): boolean {
    if (!words.every((word, k) => this.isWord(word, k))) return false;
    this.i += words.length;
    return true;
  }

  expectWord(word: string, why: string): void {
    if (!this.acceptWord(word)) throw new Maintenance(why);
  }

  acceptPunct(punct: string): boolean {
    if (!this.isPunct(punct)) return false;
    this.i++;
    return true;
  }

  next(): Token {
    const t = this.tokens[this.i];
    if (!t) throw new Maintenance('statement ends early');
    this.i++;
    return t;
  }

  /** Consume a balanced parenthesised group and return the tokens inside it. */
  group(why: string): Token[] {
    if (!this.isPunct('(')) throw new Maintenance(why);
    const open = this.i;
    let depth = 0;
    for (; this.i < this.tokens.length; this.i++) {
      const t = this.tokens[this.i]!;
      if (t.kind === 'punct' && t.value === '(') depth++;
      else if (t.kind === 'punct' && t.value === ')') {
        depth--;
        if (depth === 0) {
          this.i++;
          return this.tokens.slice(open + 1, this.i - 1);
        }
      }
    }
    throw new Maintenance('unbalanced parentheses');
  }

  /** Skip one token, or one whole group when it opens a parenthesis. */
  skipOne(): void {
    if (this.isPunct('(')) this.group('unbalanced parentheses');
    else this.next();
  }
}

/** Split tokens on commas that are not inside parentheses or brackets. */
function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === 'punct' && (t.value === '(' || t.value === '[')) depth++;
    if (t.kind === 'punct' && (t.value === ')' || t.value === ']')) depth--;
    if (depth === 0 && t.kind === 'punct' && t.value === ',') {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  parts.push(current);
  return parts;
}

/** An identifier: an unquoted word or a quoted name. */
function identifier(cursor: Cursor, what: string): string {
  const t = cursor.peek();
  if (t?.kind === 'word' || t?.kind === 'quoted') {
    cursor.i++;
    return t.value;
  }
  throw new Maintenance(`expected ${what}`);
}

/** A table name, optionally qualified by the public schema. Other schemas are not on the allowlist. */
function tableName(cursor: Cursor): string {
  const first = identifier(cursor, 'a table name');
  if (!cursor.acceptPunct('.')) return first;
  const second = identifier(cursor, 'a table name');
  if (first !== 'public') throw new Maintenance(`table in schema "${first}"`);
  return second;
}

// ---------------------------------------------------------------------------
// Statement checks

interface Context {
  /** Tables created by earlier files, plus the reserved ones. */
  existing: Set<string>;
  /** Tables created by earlier statements of this file. */
  inFile: Set<string>;
}

/** Column constraint keywords that end a column's type or a default expression. */
const COLUMN_STOP = new Set(['constraint', 'not', 'null', 'default', 'primary', 'unique', 'check', 'references', 'generated',
  'collate', 'deferrable', 'initially', 'compression', 'storage']);

/** Words a column type may not contain. */
const TYPE_STOP = new Set([...COLUMN_STOP, 'as', 'on', 'using']);

/** The serial family expands to an integer column with a volatile nextval() default and an owned sequence. */
const SERIAL_TYPES = new Set(['serial', 'bigserial', 'smallserial', 'serial2', 'serial4', 'serial8']);

/** `noSerial` is set for ADD COLUMN on an existing table and for casts. A serial column in a table created
 *  by the same file is safe: the table is empty, so there is nothing to rewrite. */
function columnType(cursor: Cursor, stopAt: (t: Token) => boolean, noSerial = false): void {
  let any = false;
  while (!cursor.done && !stopAt(cursor.peek()!)) {
    const t = cursor.peek()!;
    if (noSerial && t.kind === 'word' && SERIAL_TYPES.has(t.value)) {
      throw new Maintenance(`${t.value} implies a volatile nextval default, a table rewrite and a new sequence`);
    }
    if (t.kind === 'word' && !TYPE_STOP.has(t.value)) { cursor.i++; any = true; continue; }
    if (t.kind === 'quoted') { cursor.i++; any = true; continue; }
    if (t.kind === 'punct' && t.value === '.') { cursor.i++; continue; }
    if (t.kind === 'punct' && t.value === '(') {
      const inside = cursor.group('bad type modifier');
      if (!inside.every(x => x.kind === 'number' || (x.kind === 'punct' && x.value === ','))) throw new Maintenance('unrecognised type modifier');
      continue;
    }
    if (t.kind === 'punct' && t.value === '[') {
      cursor.i++;
      if (cursor.peek()?.kind === 'number') cursor.i++;
      if (!cursor.acceptPunct(']')) throw new Maintenance('unrecognised array type');
      continue;
    }
    throw new Maintenance(`unrecognised column type near ${JSON.stringify(t.value)}`);
  }
  if (!any) throw new Maintenance('column without a type');
}

/** Consume an expression up to the next column constraint keyword. Takes at least one token. */
function expressionTokens(cursor: Cursor, stop: Set<string>): Token[] {
  const start = cursor.i;
  cursor.skipOne();
  while (!cursor.done) {
    const t = cursor.peek()!;
    if (t.kind === 'word' && stop.has(t.value)) {
      // NOT starts a constraint only as NOT NULL (or NOT DEFERRABLE).
      if (t.value !== 'not' || cursor.isWord('null', 1) || cursor.isWord('deferrable', 1)) break;
    }
    cursor.skipOne();
  }
  return cursor.tokens.slice(start, cursor.i);
}

/** A constant default: an optionally signed number, a string, TRUE, FALSE or NULL,
 *  followed by any number of `::type` casts. */
function isConstant(tokens: Token[]): boolean {
  const c = new Cursor(tokens);
  if (c.peek()?.kind === 'op' && (c.peek()!.value === '-' || c.peek()!.value === '+') && c.peek(1)?.kind === 'number') c.i++;
  const head = c.peek();
  if (!head) return false;
  if (head.kind === 'number' || head.kind === 'string' || (head.kind === 'word' && ['true', 'false', 'null'].includes(head.value))) c.i++;
  else return false;
  while (!c.done) {
    if (!c.acceptPunct('::')) return false;
    try {
      columnType(c, t => t.kind === 'punct' && t.value === '::', true);
    } catch {
      return false;
    }
  }
  return true;
}

interface ForeignKey {
  target: string;
  onDelete?: string;
  onUpdate?: string;
}

/** REFERENCES table [(columns)] [ON DELETE action] [ON UPDATE action]; anything else is not on the allowlist. */
function references(cursor: Cursor): ForeignKey {
  const fk: ForeignKey = { target: tableName(cursor) };
  if (cursor.isPunct('(')) cursor.group('bad referenced columns');
  for (;;) {
    if (cursor.acceptWord('on', 'delete')) fk.onDelete = referentialAction(cursor);
    else if (cursor.acceptWord('on', 'update')) fk.onUpdate = referentialAction(cursor);
    else break;
  }
  if (cursor.isWord('match') || cursor.isWord('deferrable') || (cursor.isWord('not') && cursor.isWord('deferrable', 1))
    || cursor.isWord('initially')) throw new Maintenance('foreign key option not on the allowlist');
  return fk;
}

function referentialAction(cursor: Cursor): string {
  if (cursor.acceptWord('cascade')) return 'cascade';
  if (cursor.acceptWord('restrict')) return 'restrict';
  if (cursor.acceptWord('no', 'action')) return 'no action';
  if (cursor.acceptWord('set', 'null')) return 'set null';
  if (cursor.acceptWord('set', 'default')) return 'set default';
  throw new Maintenance('unrecognised referential action');
}

/** A foreign key to a table outside this file must not refuse the previous release's deletes. */
function checkForeignKey(fk: ForeignKey, table: string, ctx: Context, nullable: boolean | null): void {
  if (fk.target === table || ctx.inFile.has(fk.target)) return;
  if (fk.onUpdate !== undefined) throw new Maintenance(`foreign key to existing table "${fk.target}" with ON UPDATE`);
  if (fk.onDelete === 'cascade') return;
  if (fk.onDelete === 'set null' && nullable === true) return;
  throw new Maintenance(`foreign key to existing table "${fk.target}" without ON DELETE CASCADE (or SET NULL on a nullable column) can refuse deletes from it`);
}

function createTable(cursor: Cursor, ctx: Context): string {
  cursor.acceptWord('if', 'not', 'exists');
  const name = tableName(cursor);
  if (ctx.existing.has(name)) throw new Maintenance(`table "${name}" already exists before this file`);
  if (ctx.inFile.has(name)) throw new Maintenance(`table "${name}" is created twice in this file`);
  const body = cursor.group(`CREATE TABLE "${name}" without a column list`);
  if (!cursor.done) throw new Maintenance(`CREATE TABLE "${name}" clause not on the allowlist`);
  for (const element of splitTopLevel(body)) {
    if (!element.length) throw new Maintenance('empty table element');
    tableElement(new Cursor(element), name, ctx);
  }
  return name;
}

function tableElement(cursor: Cursor, table: string, ctx: Context): void {
  if (cursor.acceptWord('constraint')) {
    identifier(cursor, 'a constraint name');
    tableConstraint(cursor, table, ctx);
    return;
  }
  if (['primary', 'unique', 'check', 'foreign', 'exclude', 'like'].some(word => cursor.isWord(word))) {
    tableConstraint(cursor, table, ctx);
    return;
  }
  identifier(cursor, 'a column name');
  columnType(cursor, t => t.kind === 'word' && COLUMN_STOP.has(t.value));
  const constraints = columnConstraints(cursor, { constantDefaultOnly: false });
  for (const fk of constraints.foreignKeys) checkForeignKey(fk, table, ctx, constraints.nullable);
}

function tableConstraint(cursor: Cursor, table: string, ctx: Context): void {
  if (cursor.acceptWord('primary', 'key')) {
    cursor.group('PRIMARY KEY without columns');
  } else if (cursor.acceptWord('unique')) {
    if (cursor.acceptWord('nulls')) { cursor.acceptWord('not'); cursor.expectWord('distinct', 'bad NULLS clause'); }
    cursor.group('UNIQUE without columns');
  } else if (cursor.acceptWord('check')) {
    cursor.group('CHECK without an expression');
  } else if (cursor.acceptWord('foreign', 'key')) {
    cursor.group('FOREIGN KEY without columns');
    cursor.expectWord('references', 'FOREIGN KEY without REFERENCES');
    // A table-level key may span columns whose nullability is declared elsewhere, so SET NULL is not trusted here.
    checkForeignKey(references(cursor), table, ctx, null);
  } else {
    throw new Maintenance('table constraint not on the allowlist');
  }
  if (!cursor.done) throw new Maintenance('table constraint option not on the allowlist');
}

interface ColumnConstraints {
  nullable: boolean;
  constantDefault: boolean;
  foreignKeys: ForeignKey[];
}

/** Column constraints. With `constantDefaultOnly` (ADD COLUMN on an existing
 *  table) only NULL, NOT NULL and a constant DEFAULT are on the allowlist. */
function columnConstraints(cursor: Cursor, opts: { constantDefaultOnly: boolean }): ColumnConstraints {
  const out: ColumnConstraints = { nullable: true, constantDefault: false, foreignKeys: [] };
  const strict = (what: string) => {
    if (opts.constantDefaultOnly) throw new Maintenance(`ADD COLUMN with ${what}`);
  };
  while (!cursor.done) {
    if (cursor.acceptWord('constraint')) {
      strict('a named constraint');
      identifier(cursor, 'a constraint name');
      continue;
    }
    if (cursor.acceptWord('not', 'null')) { out.nullable = false; continue; }
    if (cursor.acceptWord('null')) continue;
    if (cursor.acceptWord('default')) {
      const expr = expressionTokens(cursor, COLUMN_STOP);
      // DEFAULT NULL is no default: it cannot back-fill existing rows of a NOT NULL column.
      out.constantDefault = isConstant(expr) && !(expr[0]?.kind === 'word' && expr[0]?.value === 'null');
      if (opts.constantDefaultOnly && !isConstant(expr)) throw new Maintenance('ADD COLUMN with a default that is not a constant');
      continue;
    }
    if (cursor.acceptWord('primary', 'key')) { strict('PRIMARY KEY'); out.nullable = false; continue; }
    if (cursor.acceptWord('unique')) {
      strict('UNIQUE');
      if (cursor.acceptWord('nulls')) { cursor.acceptWord('not'); cursor.expectWord('distinct', 'bad NULLS clause'); }
      continue;
    }
    if (cursor.acceptWord('check')) {
      strict('a CHECK constraint');
      cursor.group('CHECK without an expression');
      if (cursor.isWord('no')) throw new Maintenance('CHECK option not on the allowlist');
      continue;
    }
    if (cursor.acceptWord('references')) {
      strict('a foreign key');
      out.foreignKeys.push(references(cursor));
      continue;
    }
    if (cursor.acceptWord('generated')) {
      strict('a generated column');
      if (cursor.acceptWord('always')) {
        cursor.expectWord('as', 'bad GENERATED clause');
        if (cursor.acceptWord('identity')) {
          if (cursor.isPunct('(')) cursor.group('bad identity options');
        } else {
          cursor.group('GENERATED without an expression');
          cursor.expectWord('stored', 'GENERATED column that is not STORED');
        }
      } else if (cursor.acceptWord('by', 'default', 'as', 'identity')) {
        if (cursor.isPunct('(')) cursor.group('bad identity options');
      } else throw new Maintenance('bad GENERATED clause');
      continue;
    }
    throw new Maintenance(`column option not on the allowlist near ${JSON.stringify(cursor.peek()!.value)}`);
  }
  if (opts.constantDefaultOnly && !out.nullable && !out.constantDefault) throw new Maintenance('ADD COLUMN NOT NULL without a constant default');
  return out;
}

function alterTable(cursor: Cursor): void {
  cursor.acceptWord('if', 'exists');
  cursor.acceptWord('only');
  tableName(cursor);
  const actions = splitTopLevel(cursor.tokens.slice(cursor.i));
  for (const action of actions) {
    const c = new Cursor(action);
    if (!c.acceptWord('add')) throw new Maintenance(`ALTER TABLE action ${JSON.stringify(action[0]?.value ?? '')} is not on the allowlist`);
    c.acceptWord('column');
    if (c.isWord('constraint') || c.isWord('primary') || c.isWord('unique') || c.isWord('check') || c.isWord('foreign')
      || c.isWord('exclude')) throw new Maintenance('ALTER TABLE ADD CONSTRAINT');
    c.acceptWord('if', 'not', 'exists');
    identifier(c, 'a column name');
    columnType(c, t => t.kind === 'word' && COLUMN_STOP.has(t.value), true);
    columnConstraints(c, { constantDefaultOnly: true });
  }
}

function createIndex(cursor: Cursor, ctx: Context): void {
  if (cursor.isWord('concurrently')) throw new Maintenance('CREATE INDEX CONCURRENTLY');
  if (cursor.acceptWord('if', 'not', 'exists')) identifier(cursor, 'an index name');
  else if (!cursor.isWord('on')) identifier(cursor, 'an index name');
  cursor.expectWord('on', 'CREATE INDEX without ON');
  cursor.acceptWord('only');
  const table = tableName(cursor);
  if (!ctx.inFile.has(table)) throw new Maintenance(`index on table "${table}", which this file did not create (it locks an existing table)`);
  if (cursor.acceptWord('using')) identifier(cursor, 'an index method');
  cursor.group('CREATE INDEX without columns');
  if (cursor.acceptWord('include')) cursor.group('bad INCLUDE');
  if (cursor.acceptWord('nulls')) { cursor.acceptWord('not'); cursor.expectWord('distinct', 'bad NULLS clause'); }
  if (cursor.acceptWord('with')) cursor.group('bad index storage parameters');
  if (cursor.acceptWord('where')) {
    if (cursor.done) throw new Maintenance('empty index predicate');
    return;
  }
  if (!cursor.done) throw new Maintenance('CREATE INDEX clause not on the allowlist');
}

function comment(cursor: Cursor): void {
  const tokens = cursor.tokens;
  const last = tokens[tokens.length - 1];
  const beforeLast = tokens[tokens.length - 2];
  const literal = last?.kind === 'string' || (last?.kind === 'word' && last.value === 'null');
  if (!literal || beforeLast?.kind !== 'word' || beforeLast.value !== 'is' || tokens.length < 5) {
    throw new Maintenance('unrecognised COMMENT statement');
  }
}

function excerptOf(sql: string, statement: Token[]): string {
  const text = sql.slice(statement[0]!.start, statement[statement.length - 1]!.end).replace(/\s+/g, ' ');
  return text.length > 120 ? text.slice(0, 117) + '...' : text;
}

/** Table names a CREATE TABLE statement introduces, whatever else it does. */
function createdTableOf(statement: Token[]): string | null {
  const c = new Cursor(statement);
  if (!c.acceptWord('create')) return null;
  while (!c.done && !c.isWord('table')) {
    if (!['global', 'local', 'temporary', 'temp', 'unlogged'].includes(c.peek()!.value)) return null;
    c.i++;
  }
  if (!c.acceptWord('table')) return null;
  c.acceptWord('if', 'not', 'exists');
  try {
    return tableName(c);
  } catch (err) {
    if (err instanceof Maintenance) {
      // Another schema: still a name taken, so report it qualified.
      return null;
    }
    throw err;
  }
}

function classifyStatement(statement: Token[], ctx: Context): { kind: string; created?: string } {
  const c = new Cursor(statement);
  if (c.acceptWord('create', 'table')) {
    const created = createTable(c, ctx);
    return { kind: 'create-table', created };
  }
  if (c.acceptWord('create', 'index')) {
    createIndex(c, ctx);
    return { kind: 'create-index' };
  }
  if (c.acceptWord('alter', 'table')) {
    alterTable(c);
    return { kind: 'add-column' };
  }
  if (c.acceptWord('comment', 'on')) {
    comment(c);
    return { kind: 'comment' };
  }
  if (c.acceptWord('create', 'unique', 'index')) throw new Maintenance('CREATE UNIQUE INDEX');
  if (c.acceptWord('create', 'or', 'replace')) throw new Maintenance('CREATE OR REPLACE');
  const head = statement.slice(0, 2).map(t => t.value).join(' ');
  throw new Maintenance(`a statement starting "${head}" is not on the allowlist`);
}

/**
 * Classify one migration file's SQL. `existingTables` holds the tables earlier
 * files created; `schema_migrations` is always treated as existing.
 */
export function classifyMigrationSql(sql: string, existingTables: Iterable<string> = []): SqlVerdict {
  const existing = new Set([...RESERVED_TABLES, ...existingTables]);
  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch (err) {
    if (!(err instanceof SqlSyntaxError)) throw err;
    return { class: 'maintenance', reasons: [`unreadable SQL: ${err.message}`], statements: [], createdTables: [] };
  }
  const ctx: Context = { existing, inFile: new Set() };
  const statements: StatementVerdict[] = [];
  const createdTables: string[] = [];
  splitStatements(tokens).forEach((statement, k) => {
    const excerpt = excerptOf(sql, statement);
    const created = createdTableOf(statement);
    if (created !== null && !createdTables.includes(created)) createdTables.push(created);
    try {
      const verdict = classifyStatement(statement, ctx);
      if (verdict.created) ctx.inFile.add(verdict.created);
      statements.push({ index: k + 1, kind: verdict.kind, class: 'additive', reason: '', excerpt });
    } catch (err) {
      if (!(err instanceof Maintenance)) throw err;
      // Later statements may still refer to a table this one created.
      if (created !== null && !existing.has(created)) ctx.inFile.add(created);
      const kind = statement[0]?.value === 'create' && statement[1]?.value === 'table' ? 'create-table'
        : statement[0]?.value === 'alter' && statement[1]?.value === 'table' ? 'alter-table'
          : statement[0]?.value === 'create' && /^(unique|index)$/.test(statement[1]?.value ?? '') ? 'create-index'
            : 'other';
      statements.push({ index: k + 1, kind, class: 'maintenance', reason: err.message, excerpt });
    }
  });
  const reasons = statements.filter(s => s.class === 'maintenance').map(s => `statement ${s.index}: ${s.reason}`);
  return { class: reasons.length ? 'maintenance' : 'additive', reasons, statements, createdTables };
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Classify migration files in apply order. Each file is judged against the
 * tables every earlier file in `dir` created. With `only`, the verdicts are
 * limited to those names (each must exist in `dir`); the context still comes
 * from every earlier file.
 */
export async function classifyMigrations(dir = './migrations', only?: readonly string[]): Promise<MigrationVerdict[]> {
  const files = await readMigrationFiles(dir);
  if (only) {
    const missing = only.filter(name => !files.includes(name));
    if (missing.length) throw new Error(`not in ${dir}: ${missing.join(', ')}`);
  }
  const wanted = only ? new Set(only) : null;
  const known = new Set<string>();
  const verdicts: MigrationVerdict[] = [];
  for (const name of files) {
    const bytes = await readFile(join(dir, name));
    const verdict = classifyMigrationSql(bytes.toString('utf8'), known);
    for (const table of verdict.createdTables) known.add(table);
    if (!wanted || wanted.has(name)) verdicts.push({ name, sha256: sha256Hex(bytes), ...verdict });
  }
  return verdicts;
}
