/** Lexer and parser for the language subset; everything else is a DatalogError at the offending token. */
import type { SrcLine } from './preprocess.ts';
import { DatalogError } from './types.ts';

export interface Pos {
  file: string;
  line: number;
}

export type PExpr =
  | { k: 'num'; v: number; pos: Pos }
  | { k: 'str'; v: string; pos: Pos }
  | { k: 'var'; name: string; pos: Pos }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '%'; a: PExpr; b: PExpr; pos: Pos }
  | { k: 'neg'; a: PExpr; pos: Pos }
  | { k: 'fn'; name: string; args: PExpr[]; pos: Pos }
  | { k: 'agg'; kind: 'count' | 'sum' | 'min' | 'max'; e: PExpr | null; body: PLit[]; pos: Pos };

export type CmpOp = '=' | '!=' | '<' | '<=' | '>' | '>=';

export type PLit =
  | { k: 'atom'; neg: boolean; rel: string; args: PExpr[]; pos: Pos }
  | { k: 'cmp'; op: CmpOp; a: PExpr; b: PExpr; pos: Pos }
  | { k: 'pred'; neg: boolean; name: 'contains' | 'match'; args: PExpr[]; pos: Pos };

export interface PClause {
  rel: string;
  args: PExpr[];
  body: PLit[];
  pos: Pos;
}

export interface PDecl {
  name: string;
  attrs: { name: string; type: string }[];
  pos: Pos;
}

export interface PIo {
  kind: 'input' | 'output';
  name: string;
  pos: Pos;
}

export interface PProgram {
  decls: PDecl[];
  ios: PIo[];
  clauses: PClause[];
}

interface Tok {
  t: 'id' | 'num' | 'str' | 'op' | 'eof';
  v: string;
  file: string;
  line: number;
}

export const FUNCTORS = new Set(['cat', 'to_string', 'to_number', 'strlen', 'substr']);
const PREDS = new Set(['contains', 'match']);
const AGGS = new Set(['count', 'sum', 'min', 'max']);
const CMP_OPS = new Set(['=', '!=', '<', '<=', '>', '>=']);
const LEX = /\s+|([A-Za-z_][A-Za-z_0-9]*)|(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+(?:\.[0-9])?)|"((?:[^"\\\n]|\\.)*)"|(:-|!=|<=|>=|[(){},.:;=<>+\-*/%!^$@\[\]|&~?])/y;

function lex(lines: SrcLine[]): Tok[] {
  const toks: Tok[] = [];
  for (const { text, file, line } of lines) {
    LEX.lastIndex = 0;
    while (LEX.lastIndex < text.length) {
      const at = LEX.lastIndex;
      const m = LEX.exec(text);
      if (!m) throw new DatalogError(`unexpected character ${JSON.stringify(text[at])}`, file, line);
      if (m[1] !== undefined) toks.push({ t: 'id', v: m[1], file, line });
      else if (m[2] !== undefined) {
        if (m[2].includes('.')) throw new DatalogError('float literals are not supported', file, line);
        toks.push({ t: 'num', v: m[2], file, line });
      } else if (m[3] !== undefined) toks.push({ t: 'str', v: unescape(m[3], file, line), file, line });
      else if (m[4] !== undefined) toks.push({ t: 'op', v: m[4], file, line });
    }
  }
  const last = lines[lines.length - 1];
  toks.push({ t: 'eof', v: '', file: last?.file ?? '', line: last?.line ?? 0 });
  return toks;
}

const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '\\': '\\' };
function unescape(s: string, file: string, line: number): string {
  return s.replace(/\\(.)/g, (_, c) => {
    const r = ESC[c];
    if (r === undefined) throw new DatalogError(`unknown escape \\${c} in string`, file, line);
    return r;
  });
}

export function parse(lines: SrcLine[]): PProgram {
  const toks = lex(lines);
  let p = 0;
  const prog: PProgram = { decls: [], ios: [], clauses: [] };

  const peek = (n = 0): Tok => toks[Math.min(p + n, toks.length - 1)]!;
  const pos = (t: Tok): Pos => ({ file: t.file, line: t.line });
  const fail = (m: string, t = peek()): never => {
    throw new DatalogError(m, t.file, t.line);
  };
  const isOp = (v: string, n = 0) => peek(n).t === 'op' && peek(n).v === v;
  const expectOp = (v: string): Tok => (isOp(v) ? toks[p++]! : fail(`expected "${v}", found ${describe(peek())}`));
  const expectId = (what: string): Tok => (peek().t === 'id' ? toks[p++]! : fail(`expected ${what}, found ${describe(peek())}`));

  while (peek().t !== 'eof') {
    if (isOp('.')) directive();
    else clause();
  }
  return prog;

  function directive(): void {
    p++;
    const d = expectId('a directive after "."');
    switch (d.v) {
      case 'decl':
        return decl(d);
      case 'input':
      case 'output':
        for (;;) {
          const name = expectId('a relation name');
          prog.ios.push({ kind: d.v as 'input' | 'output', name: name.v, pos: pos(name) });
          if (isOp('(')) skipParens();
          if (!isOp(',')) return;
          p++;
        }
      default:
        fail(`unsupported directive .${d.v}`, d);
    }
  }

  function skipParens(): void {
    let depth = 0;
    do {
      const t = toks[p++]!;
      if (t.t === 'eof') fail('unbalanced parentheses', t);
      if (t.t === 'op' && t.v === '(') depth++;
      else if (t.t === 'op' && t.v === ')') depth--;
    } while (depth > 0);
  }

  function decl(d: Tok): void {
    const name = expectId('a relation name');
    expectOp('(');
    const attrs: PDecl['attrs'] = [];
    if (!isOp(')')) {
      for (;;) {
        const a = expectId('an attribute name');
        expectOp(':');
        const ty = expectId('a type');
        if (ty.v !== 'symbol' && ty.v !== 'number') fail(`unsupported type ${ty.v} (only symbol and number)`, ty);
        attrs.push({ name: a.v, type: ty.v });
        if (!isOp(',')) break;
        p++;
      }
    }
    expectOp(')');
    if (peek().t === 'id' && !isOp('(', 1) && !isOp(':', 1) && !isOp('.', 1) && !isOp(',', 1))
      fail(`unsupported relation qualifier ${peek().v}`);
    prog.decls.push({ name: name.v, attrs, pos: pos(d) });
  }

  function clause(): void {
    const start = peek();
    const head = atomHead();
    let body: PLit[] = [];
    if (isOp(':-')) {
      p++;
      body = literals();
    } else if (isOp(',')) fail('rules with several heads are not supported');
    expectOp('.');
    prog.clauses.push({ rel: head.rel, args: head.args, body, pos: pos(start) });
  }

  function atomHead(): { rel: string; args: PExpr[] } {
    const name = expectId('a relation name');
    expectOp('(');
    return { rel: name.v, args: argList() };
  }

  /** After "(": comma-separated expressions up to and including ")". */
  function argList(): PExpr[] {
    const args: PExpr[] = [];
    if (!isOp(')')) {
      for (;;) {
        args.push(expr());
        if (!isOp(',')) break;
        p++;
      }
    }
    expectOp(')');
    return args;
  }

  function literals(): PLit[] {
    const lits: PLit[] = [literal()];
    while (isOp(',')) {
      p++;
      lits.push(literal());
    }
    if (isOp(';')) fail('disjunction ";" is not supported');
    return lits;
  }

  function literal(): PLit {
    const t = peek();
    const neg = isOp('!');
    if (neg) p++;
    const name = peek();
    if (neg && !(name.t === 'id' && isOp('(', 1))) fail('expected a relation after "!"', name);
    if (name.t === 'id' && isOp('(', 1)) {
      if (PREDS.has(name.v)) {
        p += 2;
        const args = argList();
        if (args.length !== 2) fail(`${name.v} takes 2 arguments`, name);
        return { k: 'pred', neg, name: name.v as 'contains' | 'match', args, pos: pos(t) };
      }
      if (neg) {
        p += 2;
        return { k: 'atom', neg: true, rel: name.v, args: argList(), pos: pos(t) };
      }
      if (!FUNCTORS.has(name.v) && !AGGS.has(name.v)) {
        p += 2;
        return { k: 'atom', neg: false, rel: name.v, args: argList(), pos: pos(t) };
      }
    }
    const a = expr();
    const op = peek();
    if (op.t !== 'op' || !CMP_OPS.has(op.v)) return fail(`expected a comparison, found ${describe(op)}`);
    p++;
    return { k: 'cmp', op: op.v as CmpOp, a, b: expr(), pos: pos(t) };
  }

  function expr(): PExpr {
    let a = term();
    while (isOp('+') || isOp('-')) {
      const op = toks[p++]!;
      a = { k: 'bin', op: op.v as '+' | '-', a, b: term(), pos: pos(op) };
    }
    return a;
  }

  function term(): PExpr {
    let a = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = toks[p++]!;
      a = { k: 'bin', op: op.v as '*' | '/' | '%', a, b: unary(), pos: pos(op) };
    }
    return a;
  }

  function unary(): PExpr {
    const t = peek();
    if (isOp('-')) {
      p++;
      const a = unary();
      return a.k === 'num' ? { k: 'num', v: -a.v, pos: pos(t) } : { k: 'neg', a, pos: pos(t) };
    }
    return primary();
  }

  function primary(): PExpr {
    const t = toks[p++]!;
    switch (t.t) {
      case 'num': {
        const v = /^0[xX]/.test(t.v) ? parseInt(t.v, 16) : /^0[bB]/.test(t.v) ? parseInt(t.v.slice(2), 2) : Number(t.v);
        if (!Number.isSafeInteger(v)) fail(`number literal ${t.v} exceeds 2^53`, t);
        return { k: 'num', v, pos: pos(t) };
      }
      case 'str':
        return { k: 'str', v: t.v, pos: pos(t) };
      case 'id':
        if (AGGS.has(t.v) && aggregateAhead()) return aggregate(t);
        if (isOp('(')) {
          if (!FUNCTORS.has(t.v)) fail(`unsupported functor ${t.v}`, t);
          p++;
          return { k: 'fn', name: t.v, args: argList(), pos: pos(t) };
        }
        return { k: 'var', name: t.v, pos: pos(t) };
      case 'op':
        if (t.v === '(') {
          const e = expr();
          expectOp(')');
          return e;
        }
    }
    return fail(`unexpected ${describe(t)}`, t);
  }

  /** `count :`, `sum E :` — told apart from a functor call `max(a, b)` by the colon after the expression. */
  function aggregateAhead(): boolean {
    if (isOp(':')) return true;
    if (!isOp('(')) return peek().t === 'id' || peek().t === 'num' ? scanToColon() : false;
    return scanToColon();
  }

  function scanToColon(): boolean {
    let depth = 0;
    for (let i = p; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.t === 'eof') return false;
      if (t.t !== 'op') continue;
      if (t.v === '(') depth++;
      else if (t.v === ')') depth--;
      else if (depth === 0 && t.v === ':') return true;
      else if (depth === 0 && (t.v === ',' || t.v === '.' || t.v === ':-' || CMP_OPS.has(t.v))) return false;
      if (depth < 0) return false;
    }
    return false;
  }

  function aggregate(t: Tok): PExpr {
    const kind = t.v as 'count' | 'sum' | 'min' | 'max';
    const e = kind === 'count' ? null : expr();
    expectOp(':');
    if (!isOp('{')) fail('an aggregate body must be written { ... }');
    p++;
    const body = literals();
    expectOp('}');
    return { k: 'agg', kind, e, body, pos: pos(t) };
  }
}

function describe(t: Tok): string {
  return t.t === 'eof' ? 'end of input' : t.t === 'str' ? `string ${JSON.stringify(t.v)}` : `"${t.v}"`;
}
