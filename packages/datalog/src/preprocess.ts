/**
 * The cpp subset: `#include`, object- and function-like `#define`, `#undef`,
 * `#ifdef`/`#ifndef`/`#else`/`#endif`. Output is one entry per source line
 * that survives, each remembering its original file and line, so a parse or
 * run error always points into the author's files, not the expanded text.
 */
import { DatalogError } from './types.ts';

export interface SrcLine {
  text: string;
  file: string;
  line: number;
}

interface Macro {
  params: string[] | null;
  body: string[];
}

const TOKEN = /[A-Za-z_][A-Za-z_0-9]*|"(?:[^"\\\n]|\\.)*"|\s+|[\s\S]/g;
const IDENT = /^[A-Za-z_]/;
const MAX_DEPTH = 64;
const UNCLOSED = Symbol('unclosed macro call');

export function preprocess(
  entry: string,
  read: (path: string) => string,
  defines: Readonly<Record<string, string>> = {},
): SrcLine[] {
  const macros = new Map<string, Macro>();
  for (const [name, text] of Object.entries(defines)) macros.set(name, { params: null, body: tokenize(text) });
  const out: SrcLine[] = [];

  // Includes resolve against the including file's directory first, then as written.
  function readInclude(path: string, from: SrcLine): { path: string; text: string } {
    const dir = from.file.includes('/') ? from.file.slice(0, from.file.lastIndexOf('/') + 1) : '';
    const local = normalize(dir + path);
    try {
      return { path: local, text: read(local) };
    } catch (e) {
      if (local === path) throw new DatalogError(`cannot read include "${path}": ${msg(e)}`, from.file, from.line);
    }
    return readOr(path, from.file, from.line);
  }

  function readOr(path: string, f: string | undefined, l: number | undefined): { path: string; text: string } {
    try {
      return { path, text: read(path) };
    } catch (e) {
      throw new DatalogError(`cannot read "${path}": ${msg(e)}`, f, l);
    }
  }

  function file(path: string, source: string, depth: number): void {
    if (depth > MAX_DEPTH) throw new DatalogError('#include nested too deeply', path, 1);
    const lines = stripComments(source, path);
    // Conditional stack: each frame is [parentActive, thisBranchActive, sawElse].
    const cond: [boolean, boolean, boolean][] = [];
    const active = () => cond.every((c) => c[1]);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      const at: SrcLine = { text, file: path, line: i + 1 };
      const trimmed = text.trimStart();
      if (!trimmed.startsWith('#')) {
        if (!active() || trimmed === '') continue;
        // A macro call may run over several lines; the expansion is attributed to the first.
        let joined = text;
        for (;;) {
          try {
            out.push({ ...at, text: expandLine(joined, at) });
            break;
          } catch (e) {
            const following = lines[i + 1];
            if (e !== UNCLOSED || following === undefined || following.trimStart().startsWith('#'))
              throw e === UNCLOSED ? new DatalogError('macro call is not closed', path, at.line) : e;
            joined += ' ' + following;
            i++;
          }
        }
        continue;
      }
      let directive = trimmed;
      while (directive.endsWith('\\') && i + 1 < lines.length) directive = directive.slice(0, -1) + ' ' + lines[++i]!;
      const m = /^#\s*([a-z]+)\s*(.*)$/s.exec(directive);
      if (!m) throw new DatalogError(`bad preprocessor line`, path, at.line);
      const [, name = '', rest = ''] = m;
      switch (name) {
        case 'ifdef':
        case 'ifndef': {
          const defined = macros.has(rest.trim());
          cond.push([active(), name === 'ifdef' ? defined : !defined, false]);
          break;
        }
        case 'else': {
          const top = cond[cond.length - 1];
          if (!top || top[2]) throw new DatalogError('#else without #ifdef', path, at.line);
          top[1] = !top[1];
          top[2] = true;
          break;
        }
        case 'endif':
          if (!cond.pop()) throw new DatalogError('#endif without #ifdef', path, at.line);
          break;
        default:
          if (!active()) break;
          if (name === 'include') {
            const q = /^"([^"]+)"$|^<([^>]+)>$/.exec(rest.trim());
            if (!q) throw new DatalogError('#include needs "file"', path, at.line);
            const target = q[1] ?? q[2]!;
            const r = readInclude(target, at);
            file(r.path, r.text, depth + 1);
          } else if (name === 'define') define(rest, at);
          else if (name === 'undef') macros.delete(rest.trim());
          else throw new DatalogError(`unsupported preprocessor directive #${name}`, path, at.line);
      }
    }
    if (cond.length > 0) throw new DatalogError('#ifdef without #endif', path, lines.length);
  }

  function define(rest: string, at: SrcLine): void {
    const m = /^\s*([A-Za-z_][A-Za-z_0-9]*)(\(([^)]*)\))?\s?(.*)$/s.exec(rest);
    if (!m) throw new DatalogError('bad #define', at.file, at.line);
    const params = m[2] === undefined ? null : m[3]!.split(',').map((p) => p.trim()).filter((p) => p !== '');
    const body = tokenize(m[4]!.trim());
    if (body.some((t) => t === '#')) throw new DatalogError('# and ## in macros are not supported', at.file, at.line);
    macros.set(m[1]!, { params, body });
  }

  function expandLine(text: string, at: SrcLine): string {
    try {
      return expand(tokenize(text), new Set()).join('');
    } catch (e) {
      if (e instanceof DatalogError && e.file === undefined) throw new DatalogError(e.message, at.file, at.line);
      throw e;
    }
  }

  function expand(tokens: string[], hide: ReadonlySet<string>): string[] {
    const res: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      const mac = IDENT.test(t) && !hide.has(t) ? macros.get(t) : undefined;
      if (!mac) {
        res.push(t);
        continue;
      }
      const inner = new Set(hide).add(t);
      if (mac.params === null) {
        res.push(...expand(mac.body, inner));
        continue;
      }
      let j = i + 1;
      while (j < tokens.length && /^\s+$/.test(tokens[j]!)) j++;
      if (tokens[j] !== '(') {
        res.push(t);
        continue;
      }
      const args: string[][] = [[]];
      let depth = 0;
      for (j++; j < tokens.length; j++) {
        const a = tokens[j]!;
        if (a === '(') depth++;
        else if (a === ')') {
          if (depth === 0) break;
          depth--;
        }
        if (a === ',' && depth === 0) args.push([]);
        else args[args.length - 1]!.push(a);
      }
      if (j >= tokens.length) throw UNCLOSED;
      if (mac.params.length === 0 && args.length === 1 && args[0]!.every((x) => /^\s*$/.test(x))) args.length = 0;
      if (args.length !== mac.params.length)
        throw new DatalogError(`macro ${t} takes ${mac.params.length} argument(s), got ${args.length}`);
      const expanded = args.map((a) => expand(a, hide));
      const body: string[] = [];
      for (const b of mac.body) {
        const p = mac.params.indexOf(b);
        if (p >= 0) body.push(...expanded[p]!);
        else body.push(b);
      }
      res.push(...expand(body, inner));
      i = j;
    }
    return res;
  }

  const first = readOr(entry, undefined, undefined);
  file(first.path, first.text, 0);
  return out;
}

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.split('/')) {
    if (p === '.' || (p === '' && parts.length > 0)) continue;
    if (p === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Replace comments by whitespace, keeping every newline so line numbers survive. */
function stripComments(src: string, file: string): string[] {
  let out = '';
  let line = 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
      line++;
    } else if (c === '/' && src[i + 1] === '*') {
      const start = line;
      i += 2;
      out += ' ';
      for (; i < src.length && !(src[i] === '*' && src[i + 1] === '/'); i++) {
        if (src[i] === '\n') {
          out += '\n';
          line++;
        }
      }
      if (i >= src.length) throw new DatalogError('unterminated /* comment', file, start);
      i++;
    } else {
      out += c;
      if (c === '\n') line++;
    }
  }
  return out.split(/\r?\n/);
}
