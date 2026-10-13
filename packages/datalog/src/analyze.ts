/**
 * Names → slots, types, dependency edges. A rule's variables become slots of
 * one frame (aggregate-local variables get their own slots), and an
 * expression in an atom argument becomes a fresh slot plus an equality, so the
 * evaluator only ever sees variables and constants in atoms.
 */
import type { CmpOp, PClause, PExpr, PLit, PProgram, Pos } from './parse.ts';
import { FUNCTORS } from './parse.ts';
import { DatalogError } from './types.ts';

export type Ty = 'n' | 's';
export type AggKind = 'count' | 'sum' | 'min' | 'max';

export type Ex =
  | { k: 'c'; v: number; t: Ty }
  | { k: 'v'; slot: number }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '%'; a: Ex; b: Ex; pos: Pos }
  | { k: 'neg'; a: Ex }
  | { k: 'fn'; name: string; args: Ex[]; pos: Pos }
  | { k: 'agg'; kind: AggKind; e: Ex | null; body: Lit[]; locals: number[]; outer: number[]; pos: Pos };

export type Arg = { k: 'c'; v: number } | { k: 'v'; slot: number } | { k: 'w' };

export type Lit =
  | { k: 'atom'; rel: number; args: Arg[]; neg: boolean; pos: Pos }
  | { k: 'cmp'; op: CmpOp; a: Ex; b: Ex; pos: Pos }
  | { k: 'pred'; neg: boolean; name: 'contains' | 'match'; a: Ex; b: Ex; pos: Pos };

export interface RelInfo {
  name: string;
  idx: number;
  attrs: { name: string; type: 'symbol' | 'number' }[];
  types: Ty[];
  input: boolean;
  output: boolean;
  pos: Pos;
}

export interface Rule {
  rel: number;
  head: Ex[];
  body: Lit[];
  names: string[];
  types: (Ty | undefined)[];
  pos: Pos;
}

export interface Dep {
  rel: number;
  strict: boolean;
  pos: Pos;
}

const SIG: Record<string, { args: Ty[] | 'cat'; ret: Ty }> = {
  cat: { args: 'cat', ret: 's' },
  to_string: { args: ['n'], ret: 's' },
  to_number: { args: ['s'], ret: 'n' },
  strlen: { args: ['s'], ret: 'n' },
  substr: { args: ['s', 'n', 'n'], ret: 's' },
};

const err = (m: string, p: Pos): never => {
  throw new DatalogError(m, p.file, p.line);
};

export function analyze(prog: PProgram, sym: (s: string) => number): { rels: RelInfo[]; rules: Rule[] } {
  const rels: RelInfo[] = [];
  const byName = new Map<string, RelInfo>();
  for (const d of prog.decls) {
    if (byName.has(d.name)) err(`relation ${d.name} is declared twice`, d.pos);
    const info: RelInfo = {
      name: d.name,
      idx: rels.length,
      attrs: d.attrs.map((a) => ({ name: a.name, type: a.type as 'symbol' | 'number' })),
      types: d.attrs.map((a) => (a.type === 'number' ? 'n' : 's')),
      input: false,
      output: false,
      pos: d.pos,
    };
    rels.push(info);
    byName.set(d.name, info);
  }
  for (const io of prog.ios) {
    const r = byName.get(io.name) ?? err(`.${io.kind} of undeclared relation ${io.name}`, io.pos);
    r[io.kind] = true;
  }
  const lookup = (name: string, n: number, pos: Pos): RelInfo => {
    const r = byName.get(name) ?? err(`undeclared relation ${name}`, pos);
    if (r.attrs.length !== n) err(`${name} has ${r.attrs.length} attribute(s), used with ${n}`, pos);
    return r;
  };

  const rules = prog.clauses.map((c) => resolveClause(c, rels, lookup, sym));
  return { rels, rules };
}

interface Builder {
  names: string[];
  types: (Ty | undefined)[];
  rels: RelInfo[];
  lookup: (name: string, n: number, pos: Pos) => RelInfo;
  sym: (s: string) => number;
}

function resolveClause(c: PClause, rels: RelInfo[], lookup: Builder['lookup'], sym: Builder['sym']): Rule {
  const head = lookup(c.rel, c.args.length, c.pos);
  const b: Builder = { names: [], types: [], rels, lookup, sym };
  const r = resolveScope(b, c.body, c.args, new Map());
  const rule: Rule = { rel: head.idx, head: r.exprs, body: r.lits, names: b.names, types: b.types, pos: c.pos };
  infer(rule, rels);
  return rule;
}

interface Scoped {
  lits: Lit[];
  exprs: Ex[];
  locals: number[];
}

/**
 * Resolve one scope: the rule itself or an aggregate body. A name is local to
 * the innermost scope that mentions it unless an enclosing scope also does —
 * that is what makes an aggregate "correlated through outer variables".
 */
function resolveScope(b: Builder, plits: PLit[], pexprs: PExpr[], env: Map<string, number>): Scoped {
  const scope = new Map(env);
  const locals: number[] = [];
  const own = new Set<string>();
  for (const l of plits) ownNames(l, own);
  for (const e of pexprs) ownNames(e, own);
  for (const n of own) {
    if (n === '_' || scope.has(n)) continue;
    scope.set(n, newSlot(b, n, locals));
  }
  // Names that only live inside aggregates: local to that aggregate, unshared.
  const aggLocal = new Set<string>();
  const lits: Lit[] = [];
  const conv = (e: PExpr): Ex => expr(b, e, scope, aggLocal, locals);
  for (const l of plits) {
    switch (l.k) {
      case 'atom': {
        const rel = b.lookup(l.rel, l.args.length, l.pos);
        const extra: Lit[] = [];
        const args = l.args.map((a, i): Arg => {
          if (a.k === 'var') return a.name === '_' ? { k: 'w' } : { k: 'v', slot: scope.get(a.name)! };
          if (a.k === 'num' || a.k === 'str') {
            if (rel.types[i] !== (a.k === 'num' ? 'n' : 's')) err(`${rel.name} attribute ${i + 1} is a ${rel.attrs[i]!.type}`, l.pos);
            return { k: 'c', v: a.k === 'num' ? a.v : b.sym(a.v) };
          }
          const slot = newSlot(b, `$${b.names.length}`, locals);
          extra.push({ k: 'cmp', op: '=', a: { k: 'v', slot }, b: conv(a), pos: l.pos });
          return { k: 'v', slot };
        });
        lits.push({ k: 'atom', rel: rel.idx, args, neg: l.neg, pos: l.pos }, ...extra);
        break;
      }
      case 'cmp':
        lits.push({ k: 'cmp', op: l.op, a: conv(l.a), b: conv(l.b), pos: l.pos });
        break;
      case 'pred':
        lits.push({ k: 'pred', neg: l.neg, name: l.name, a: conv(l.args[0]!), b: conv(l.args[1]!), pos: l.pos });
    }
  }
  const exprs = pexprs.map(conv);
  return { lits, exprs, locals };
}

function newSlot(b: Builder, name: string, locals: number[]): number {
  b.names.push(name);
  b.types.push(undefined);
  locals.push(b.names.length - 1);
  return b.names.length - 1;
}

function hasAgg(n: PExpr | PLit): boolean {
  switch (n.k) {
    case 'agg':
      return true;
    case 'bin':
    case 'cmp':
      return hasAgg(n.a) || hasAgg(n.b);
    case 'neg':
      return hasAgg(n.a);
    case 'fn':
    case 'pred':
    case 'atom':
      return n.args.some(hasAgg);
    default:
      return false;
  }
}

/** Variable names an expression/literal mentions, not looking inside aggregate bodies. */
function ownNames(n: PExpr | PLit, out: Set<string>): void {
  switch (n.k) {
    case 'var':
      out.add(n.name);
      break;
    case 'bin':
      ownNames(n.a, out);
      ownNames(n.b, out);
      break;
    case 'neg':
      ownNames(n.a, out);
      break;
    case 'fn':
    case 'pred':
    case 'atom':
      for (const a of n.args) ownNames(a, out);
      break;
    case 'cmp':
      ownNames(n.a, out);
      ownNames(n.b, out);
  }
}

function expr(b: Builder, e: PExpr, scope: Map<string, number>, aggLocal: Set<string>, locals: number[]): Ex {
  const go = (x: PExpr) => expr(b, x, scope, aggLocal, locals);
  switch (e.k) {
    case 'num':
      return { k: 'c', v: e.v, t: 'n' };
    case 'str':
      return { k: 'c', v: b.sym(e.v), t: 's' };
    case 'var':
      return e.name === '_' ? err('"_" is only allowed as an atom argument', e.pos) : { k: 'v', slot: scope.get(e.name)! };
    case 'bin':
      return { k: 'bin', op: e.op, a: go(e.a), b: go(e.b), pos: e.pos };
    case 'neg':
      return { k: 'neg', a: go(e.a) };
    case 'fn':
      return { k: 'fn', name: e.name, args: e.args.map(go), pos: e.pos };
    case 'agg': {
      // A name seen only inside this aggregate is local to it; two sibling
      // aggregates sharing such a name would be ungrounded in Soufflé.
      const inner = new Set<string>();
      for (const l of e.body) ownNames(l, inner);
      if (e.e) ownNames(e.e, inner);
      for (const n of inner) {
        if (n === '_' || scope.has(n)) continue;
        if (aggLocal.has(n)) err(`variable ${n} is used by two aggregates but bound outside neither`, e.pos);
        aggLocal.add(n);
      }
      if (e.body.some(hasAgg) || (e.e && hasAgg(e.e))) err('nested aggregates are not supported', e.pos);
      const r = resolveScope(b, e.body, e.e ? [e.e] : [], scope);
      const used = new Set<number>();
      for (const l of r.lits) litSlots(l, used);
      for (const x of r.exprs) exSlots(x, used);
      for (const s of r.locals) used.delete(s);
      // Soufflé treats an outer variable in the aggregated expression inconsistently (it shadows or reads it unbound).
      const target = new Set<number>();
      if (r.exprs[0]) exSlots(r.exprs[0], target);
      for (const s of target) if (used.has(s)) err(`variable ${b.names[s]} is both aggregated and bound outside the aggregate; rename the aggregated one`, e.pos);
      return { k: 'agg', kind: e.kind, e: r.exprs[0] ?? null, body: r.lits, locals: r.locals, outer: [...used], pos: e.pos };
    }
  }
}

/** Slots an expression reads from outside itself (an aggregate contributes only its outer slots). */
export function exSlots(e: Ex, out: Set<number>): void {
  switch (e.k) {
    case 'v':
      out.add(e.slot);
      break;
    case 'bin':
      exSlots(e.a, out);
      exSlots(e.b, out);
      break;
    case 'neg':
      exSlots(e.a, out);
      break;
    case 'fn':
      for (const a of e.args) exSlots(a, out);
      break;
    case 'agg':
      for (const s of e.outer) out.add(s);
  }
}

export function litSlots(l: Lit, out: Set<number>): void {
  if (l.k === 'atom') {
    for (const a of l.args) if (a.k === 'v') out.add(a.slot);
  } else {
    exSlots(l.a, out);
    exSlots(l.b, out);
  }
}

function infer(rule: Rule, rels: RelInfo[]): void {
  const { types } = rule;
  const headTypes = rels[rule.rel]!.types;
  let changed = true;
  const mismatch = (what: string, pos: Pos): never => err(`type error: ${what}`, pos);
  const setVar = (slot: number, t: Ty, pos: Pos): void => {
    if (types[slot] === undefined) {
      types[slot] = t;
      changed = true;
    } else if (types[slot] !== t) mismatch(`${rule.names[slot]} is used as both number and symbol`, pos);
  };
  const ty = (e: Ex): Ty | undefined =>
    e.k === 'c' ? e.t : e.k === 'v' ? types[e.slot] : e.k === 'fn' ? SIG[e.name]!.ret : 'n';
  const name = (t: Ty) => (t === 'n' ? 'number' : 'symbol');
  const want = (e: Ex, t: Ty, pos: Pos): void => {
    switch (e.k) {
      case 'c':
        if (e.t !== t) mismatch(`expected ${name(t)}, found a ${name(e.t)} constant`, pos);
        return;
      case 'v':
        return setVar(e.slot, t, pos);
      case 'bin':
      case 'neg':
        if (t !== 'n') mismatch('arithmetic yields a number, a symbol is expected', pos);
        if (e.k === 'neg') return want(e.a, 'n', pos);
        want(e.a, 'n', e.pos);
        return want(e.b, 'n', e.pos);
      case 'fn': {
        if (!FUNCTORS.has(e.name)) err(`unsupported functor ${e.name}`, e.pos);
        const sig = SIG[e.name]!;
        if (sig.ret !== t) mismatch(`${e.name} yields a ${name(sig.ret)}, a ${name(t)} is expected`, e.pos);
        const n = sig.args === 'cat' ? e.args.length : sig.args.length;
        if (e.args.length !== n || n === 0) mismatch(`${e.name} takes ${sig.args === 'cat' ? 'at least 1' : n} argument(s)`, e.pos);
        e.args.forEach((a, i) => want(a, sig.args === 'cat' ? 's' : sig.args[i]!, e.pos));
        return;
      }
      case 'agg':
        if (t !== 'n') mismatch('an aggregate yields a number, a symbol is expected', e.pos);
        if (e.e) want(e.e, 'n', e.pos);
        for (const l of e.body) lit(l);
    }
  };
  const lit = (l: Lit): void => {
    switch (l.k) {
      case 'atom': {
        const rt = rels[l.rel]!.types;
        l.args.forEach((a, i) => {
          if (a.k === 'v') setVar(a.slot, rt[i]!, l.pos);
        });
        return;
      }
      case 'cmp': {
        const t = ty(l.a) ?? ty(l.b);
        if (t) {
          want(l.a, t, l.pos);
          want(l.b, t, l.pos);
        }
        return;
      }
      case 'pred':
        want(l.a, 's', l.pos);
        want(l.b, 's', l.pos);
    }
  };
  rule.head.forEach((h, i) => want(h, headTypes[i]!, rule.pos));
  while (changed) {
    changed = false;
    rule.head.forEach((h, i) => want(h, headTypes[i]!, rule.pos));
    for (const l of rule.body) lit(l);
  }
  types.forEach((t, i) => {
    if (t === undefined) err(`cannot infer the type of variable ${rule.names[i]}`, rule.pos);
  });
}

/** Dependencies of a rule's head on relations: positive atoms are plain, negation and aggregate bodies strict. */
export function ruleDeps(rule: Rule): Dep[] {
  const out: Dep[] = [];
  const inEx = (e: Ex): void => {
    switch (e.k) {
      case 'bin':
        inEx(e.a);
        inEx(e.b);
        break;
      case 'neg':
        inEx(e.a);
        break;
      case 'fn':
        e.args.forEach(inEx);
        break;
      case 'agg':
        if (e.e) inEx(e.e);
        for (const l of e.body) inLit(l, true);
    }
  };
  const inLit = (l: Lit, strict: boolean): void => {
    if (l.k === 'atom') out.push({ rel: l.rel, strict: strict || l.neg, pos: l.pos });
    else {
      inEx(l.a);
      inEx(l.b);
    }
  };
  rule.head.forEach(inEx);
  for (const l of rule.body) inLit(l, false);
  return out;
}
