/**
 * Rule bodies → nested-loop closures. A body is ordered once at compile time
 * (filters as soon as their variables are bound, then the atom with the most
 * bound columns, so lookups hit a hash index), then each step becomes a
 * closure that calls the next one. A frame — one number per variable — is the
 * only state; a failing expression yields NaN and the step drops the binding.
 */
import { exSlots, litSlots } from './analyze.ts';
import type { Ex, Lit, RelInfo, Rule, Ty } from './analyze.ts';
import { regexMatch, substr, symLess, toNumber, utf8Length } from './functors.ts';
import type { Pos } from './parse.ts';
import type { Rel, Syms } from './store.ts';
import { DatalogError } from './types.ts';

export type Frame = number[];
export type Fn = (f: Frame) => void;

/** What compiled closures read at run time: the relations of the current run and iteration. */
export interface Ctx {
  full: Rel[];
  delta: (Rel | undefined)[];
  pend: Rel[];
}

type Num = (f: Frame) => number;

const MAXI = Number.MAX_SAFE_INTEGER;
const overflow = (): never => {
  throw new DatalogError('number overflow (results beyond 2^53 are not supported)');
};

const unbound = (rule: Rule, slot: number, pos: Pos): never => {
  throw new DatalogError(`variable ${rule.names[slot]} is not grounded by any positive atom`, pos.file, pos.line);
};

export class Planner {
  readonly rels: RelInfo[];
  readonly syms: Syms;
  readonly ctx: Ctx;

  constructor(rels: RelInfo[], syms: Syms, ctx: Ctx) {
    this.rels = rels;
    this.syms = syms;
    this.ctx = ctx;
  }

  tyOf(e: Ex, rule: Rule): Ty {
    return e.k === 'c' ? e.t : e.k === 'v' ? rule.types[e.slot]! : e.k === 'fn' ? FN_RET[e.name]! : 'n';
  }

  /** Compile a rule body with the given terminal; `deltaAt` is the body index of the atom read from the delta. */
  body(rule: Rule, lits: Lit[], bound: Iterable<number>, deltaAt: number, need: Set<number>, end: Fn): Fn {
    const have = new Set(bound);
    const steps = this.order(rule, lits, have, deltaAt);
    for (const s of need) if (!have.has(s)) unbound(rule, s, rule.pos);
    let next = end;
    for (let i = steps.length - 1; i >= 0; i--) next = this.step(rule, steps[i]!, next);
    return next;
  }

  // ---- ordering ----------------------------------------------------------

  private order(rule: Rule, lits: Lit[], have: Set<number>, deltaAt: number): Step[] {
    const steps: Step[] = [];
    const left = new Set(lits.keys());
    const ready = (e: Ex) => {
      const s = new Set<number>();
      exSlots(e, s);
      for (const x of s) if (!have.has(x)) return false;
      return true;
    };
    const takeAtom = (i: number, delta: boolean) => {
      const l = lits[i] as Extract<Lit, { k: 'atom' }>;
      steps.push(this.scanStep(l, have, delta));
      left.delete(i);
    };
    if (deltaAt >= 0) takeAtom(deltaAt, true);
    for (;;) {
      let moved = false;
      for (const i of left) {
        const l = lits[i]!;
        if (l.k === 'atom') {
          if (l.neg && l.args.every((a) => a.k !== 'v' || have.has(a.slot))) {
            steps.push(this.scanStep(l, have, false));
            left.delete(i);
            moved = true;
            break;
          }
          continue;
        }
        if (l.k === 'cmp' && l.op === '=') {
          const target = (x: Ex, y: Ex) => (x.k === 'v' && !have.has(x.slot) && ready(y) ? x.slot : -1);
          const t1 = target(l.a, l.b);
          const t2 = t1 >= 0 ? -1 : target(l.b, l.a);
          if (t1 >= 0 || t2 >= 0) {
            steps.push({ k: 'assign', slot: t1 >= 0 ? t1 : t2, e: t1 >= 0 ? l.b : l.a, pos: l.pos });
            have.add(t1 >= 0 ? t1 : t2);
            left.delete(i);
            moved = true;
            break;
          }
        }
        if (ready(l.a) && ready(l.b)) {
          steps.push({ k: 'filter', lit: l });
          left.delete(i);
          moved = true;
          break;
        }
      }
      if (moved) continue;
      // The positive atom with the most bound columns; a fully bound one is a mere check, so first.
      let best = -1;
      let bestScore = -1;
      for (const i of left) {
        const l = lits[i]!;
        if (l.k !== 'atom' || l.neg) continue;
        let bnd = 0;
        let free = 0;
        for (const a of l.args) {
          if (a.k === 'c' || (a.k === 'v' && have.has(a.slot))) bnd++;
          else if (a.k === 'v') free++;
        }
        const score = (free === 0 ? 1000 : 0) + bnd;
        if (score > bestScore) {
          best = i;
          bestScore = score;
        }
      }
      if (best < 0) break;
      takeAtom(best, false);
    }
    if (left.size > 0) {
      const l = lits[[...left][0]!]!;
      const s = new Set<number>();
      litSlots(l, s);
      for (const x of s) if (!have.has(x)) unbound(rule, x, l.pos);
      throw new DatalogError('cannot order the literals of this rule', l.pos.file, l.pos.line);
    }
    return steps;
  }

  private scanStep(l: Extract<Lit, { k: 'atom' }>, have: Set<number>, delta: boolean): Step {
    const keyCols: number[] = [];
    const keySrc: KeySrc[] = [];
    const binds: [number, number][] = [];
    const eqs: [number, number][] = [];
    const first = new Map<number, number>();
    l.args.forEach((a, col) => {
      if (a.k === 'c') {
        keyCols.push(col);
        keySrc.push({ slot: -1, c: a.v });
      } else if (a.k === 'v') {
        if (have.has(a.slot)) {
          keyCols.push(col);
          keySrc.push({ slot: a.slot, c: 0 });
        } else if (first.has(a.slot)) eqs.push([col, a.slot]);
        else {
          first.set(a.slot, col);
          binds.push([col, a.slot]);
        }
      }
    });
    if (!l.neg) for (const [, slot] of binds) have.add(slot);
    return { k: l.neg ? 'neg' : 'scan', rel: l.rel, arity: l.args.length, delta, keyCols, keySrc, binds, eqs };
  }

  // ---- step closures -----------------------------------------------------

  private step(rule: Rule, s: Step, next: Fn): Fn {
    const { ctx } = this;
    switch (s.k) {
      case 'assign': {
        const e = this.expr(s.e, rule);
        const slot = s.slot;
        return (f) => {
          const v = e(f);
          if (v === v) {
            f[slot] = v;
            next(f);
          }
        };
      }
      case 'filter':
        return this.filter(rule, s.lit, next);
      case 'neg': {
        const { rel } = s;
        const key = keyFn(s.keySrc);
        if (s.keyCols.length === 0) return (f) => ctx.full[rel]!.tuples.length === 0 && next(f);
        if (s.keyCols.length === s.arity) return (f) => !ctx.full[rel]!.set.has(key(f)) && next(f);
        const { cols, mask } = colMask(s.keyCols);
        return (f) => ctx.full[rel]!.lookup(mask, cols, key(f)) === undefined && next(f);
      }
      case 'scan': {
        const { rel, delta } = s;
        const nb = s.binds.length;
        const bcols = s.binds.map((b) => b[0]);
        const bslots = s.binds.map((b) => b[1]);
        const ecols = s.eqs.map((e) => e[0]);
        const eslots = s.eqs.map((e) => e[1]);
        const ne = ecols.length;
        const loop = (f: Frame, t: number[]): void => {
          for (let i = 0; i < nb; i++) f[bslots[i]!] = t[bcols[i]!]!;
          for (let i = 0; i < ne; i++) if (t[ecols[i]!] !== f[eslots[i]!]) return;
          next(f);
        };
        const src = (): Rel => (delta ? ctx.delta[rel]! : ctx.full[rel]!);
        if (s.keyCols.length === 0)
          return (f) => {
            const ts = src().tuples;
            for (let i = 0; i < ts.length; i++) loop(f, ts[i]!);
          };
        const key = keyFn(s.keySrc);
        if (s.keyCols.length === s.arity && !delta)
          return (f) => {
            if (ctx.full[rel]!.set.has(key(f))) next(f);
          };
        const { cols, mask } = colMask(s.keyCols);
        return (f) => {
          const b = src().lookup(mask, cols, key(f));
          if (b === undefined) return;
          for (let i = 0; i < b.length; i++) loop(f, b[i]!);
        };
      }
    }
  }

  private filter(rule: Rule, l: Extract<Lit, { k: 'cmp' | 'pred' }>, next: Fn): Fn {
    const a = this.expr(l.a, rule);
    const b = this.expr(l.b, rule);
    const S = this.syms;
    if (l.k === 'pred') {
      const test = l.name === 'contains' ? (x: string, y: string) => y.includes(x) : regexMatch;
      const want = !l.neg;
      return (f) => {
        const x = a(f);
        const y = b(f);
        if (x === x && y === y && test(S.strs[x]!, S.strs[y]!) === want) next(f);
      };
    }
    const sym = this.tyOf(l.a, rule) === 's';
    const less = sym ? (x: number, y: number) => symLess(S.strs[x]!, S.strs[y]!) : (x: number, y: number) => x < y;
    const test: (x: number, y: number) => boolean = {
      '=': (x: number, y: number) => x === y,
      '!=': (x: number, y: number) => x !== y,
      '<': less,
      '>': (x: number, y: number) => less(y, x),
      '<=': (x: number, y: number) => !less(y, x),
      '>=': (x: number, y: number) => !less(x, y),
    }[l.op];
    return (f) => {
      const x = a(f);
      const y = b(f);
      if (x === x && y === y && test(x, y)) next(f);
    };
  }

  // ---- expressions -------------------------------------------------------

  expr(e: Ex, rule: Rule): Num {
    const S = this.syms;
    switch (e.k) {
      case 'c': {
        const v = e.v;
        return () => v;
      }
      case 'v': {
        const s = e.slot;
        return (f) => f[s]!;
      }
      case 'neg': {
        const a = this.expr(e.a, rule);
        return (f) => -a(f);
      }
      case 'bin': {
        const a = this.expr(e.a, rule);
        const b = this.expr(e.b, rule);
        switch (e.op) {
          case '+':
            return (f) => {
              const r = a(f) + b(f);
              return r > MAXI || r < -MAXI ? overflow() : r;
            };
          case '-':
            return (f) => {
              const r = a(f) - b(f);
              return r > MAXI || r < -MAXI ? overflow() : r;
            };
          case '*':
            return (f) => {
              const r = a(f) * b(f);
              return r > MAXI || r < -MAXI ? overflow() : r;
            };
          case '/':
            return (f) => {
              const n = a(f);
              const d = b(f);
              if (d === 0) throw new DatalogError('division by zero');
              return (n - (n % d)) / d;
            };
          case '%':
            return (f) => {
              const n = a(f);
              const d = b(f);
              if (d === 0) throw new DatalogError('division by zero');
              return n % d;
            };
        }
        break;
      }
      case 'fn': {
        const args = e.args.map((x) => this.expr(x, rule));
        switch (e.name) {
          case 'cat':
            return lift(args, (...ids) => {
              let s = '';
              for (const i of ids) s += S.strs[i]!;
              return S.id(s);
            });
          case 'to_string':
            return lift(args, (n) => S.id(String(n)));
          case 'to_number':
            return lift(args, (i) => toNumber(S.strs[i]!));
          case 'strlen':
            return lift(args, (i) => (S.blen[i] ??= utf8Length(S.strs[i]!)));
          case 'substr':
            return lift(args, (i, from, n) => S.id(substr(S.strs[i]!, from, n)));
        }
        break;
      }
      case 'agg':
        return this.aggregate(e, rule);
    }
    throw new DatalogError('unsupported expression');
  }

  private aggregate(e: Extract<Ex, { k: 'agg' }>, rule: Rule): Num {
    const cell = { v: 0, has: false };
    const val = e.e ? this.expr(e.e, rule) : null;
    const { kind } = e;
    let end: Fn;
    if (kind === 'count') end = () => void cell.v++;
    else if (kind === 'sum')
      end = (f) => {
        const x = val!(f);
        if (x === x) {
          cell.v += x;
          if (cell.v > MAXI || cell.v < -MAXI) overflow();
        }
      };
    else {
      const min = kind === 'min';
      end = (f) => {
        const x = val!(f);
        if (x === x && (!cell.has || (min ? x < cell.v : x > cell.v))) {
          cell.v = x;
          cell.has = true;
        }
      };
    }
    const need = new Set<number>();
    if (e.e) exSlots(e.e, need);
    const run = this.body(rule, e.body, e.outer, -1, need, end);
    return (f) => {
      cell.v = 0;
      cell.has = false;
      run(f);
      return (kind === 'min' || kind === 'max') && !cell.has ? NaN : cell.v;
    };
  }
}

const FN_RET: Record<string, Ty> = { cat: 's', to_string: 's', to_number: 'n', strlen: 'n', substr: 's' };

/** Apply `fn` to evaluated arguments, propagating a failed (NaN) argument as failure. */
function lift(args: Num[], fn: (...v: number[]) => number): Num {
  const n = args.length;
  if (n === 1) {
    const a = args[0]!;
    return (f) => {
      const x = a(f);
      return x === x ? fn(x) : NaN;
    };
  }
  if (n === 2) {
    const a = args[0]!;
    const b = args[1]!;
    return (f) => {
      const x = a(f);
      const y = b(f);
      return x === x && y === y ? fn(x, y) : NaN;
    };
  }
  if (n === 3) {
    const a = args[0]!;
    const b = args[1]!;
    const c = args[2]!;
    return (f) => {
      const x = a(f);
      const y = b(f);
      const z = c(f);
      return x === x && y === y && z === z ? fn(x, y, z) : NaN;
    };
  }
  return (f) => {
    const v = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const x = args[i]!(f);
      if (x !== x) return NaN;
      v[i] = x;
    }
    return fn(...v);
  };
}

interface KeySrc {
  slot: number;
  c: number;
}

export type Step =
  | { k: 'assign'; slot: number; e: Ex; pos: Pos }
  | { k: 'filter'; lit: Extract<Lit, { k: 'cmp' | 'pred' }> }
  | {
      k: 'scan' | 'neg';
      rel: number;
      arity: number;
      delta: boolean;
      keyCols: number[];
      keySrc: KeySrc[];
      binds: [number, number][];
      eqs: [number, number][];
    };

function colMask(cols: number[]): { cols: number[]; mask: number } {
  let mask = 0;
  for (const c of cols) mask |= 1 << c;
  return { cols, mask };
}

/** Builds the same key `keyOf` computes for a stored tuple, from the frame. */
function keyFn(src: KeySrc[]): (f: Frame) => number | string {
  const n = src.length;
  const slots = src.map((s) => s.slot);
  const cs = src.map((s) => s.c);
  const get = (f: Frame, i: number): number => (slots[i]! >= 0 ? f[slots[i]!]! : cs[i]!);
  if (n === 0) return () => 0;
  if (n === 1) return slots[0]! >= 0 ? (f) => f[slots[0]!]! : () => cs[0]!;
  if (n === 2) return (f) => get(f, 0) + ',' + get(f, 1);
  return (f) => {
    let s = '' + get(f, 0);
    for (let i = 1; i < n; i++) s += ',' + get(f, i);
    return s;
  };
}
