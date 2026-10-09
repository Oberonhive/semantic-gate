/**
 * Compile a program (preprocess → parse → analyze → stratify → plan) and
 * evaluate it semi-naively, stratum by stratum. Strata that cannot see an
 * `.input` relation are evaluated once, the first time the program runs, and
 * shared by every run after; only the strata downstream of host facts are
 * recomputed.
 */
import { analyze, exSlots, ruleDeps } from './analyze.ts';
import type { Ex, RelInfo, Rule } from './analyze.ts';
import { parse } from './parse.ts';
import { Planner } from './plan.ts';
import type { Ctx, Fn, Frame } from './plan.ts';
import { preprocess } from './preprocess.ts';
import { Rel, Syms } from './store.ts';
import { DatalogError } from './types.ts';
import type { CompileOptions, Program, RelationDecl, Tuple, Value } from './types.ts';

interface Compiled {
  run: Fn;
  frame: Frame;
  rule: Rule;
}

interface Stratum {
  rels: number[];
  base: Compiled[];
  rec: { c: Compiled; deltaRel: number }[];
  dynamic: boolean;
}

export function build(entry: string, options: CompileOptions): Program {
  const syms = new Syms();
  const prog = parse(preprocess(entry, options.read, options.defines));
  const { rels, rules } = analyze(prog, (s) => syms.id(s));
  for (const r of rels) if (r.attrs.length > 30) throw new DatalogError(`${r.name}: more than 30 attributes`, r.pos.file, r.pos.line);

  const ctx: Ctx = { full: [], delta: [], pend: [] };
  const planner = new Planner(rels, syms, ctx);

  const facts: number[][][] = rels.map(() => []);
  const proper: Rule[] = [];
  for (const r of rules) {
    if (r.body.length === 0 && r.head.every(isConst)) facts[r.rel]!.push(r.head.map((h) => constant(planner, h, r)));
    else proper.push(r);
  }
  const strata = stratify(rels, proper, planner);

  const relations = new Map<string, RelationDecl>();
  for (const r of rels) relations.set(r.name, { name: r.name, attributes: r.attrs, input: r.input, output: r.output });
  const dynamicRel = new Set<number>();
  for (const s of strata) if (s.dynamic) for (const r of s.rels) dynamicRel.add(r);

  let shared: Rel[] | undefined;

  const seed = (full: Rel[], only: (i: number) => boolean) => {
    for (const r of rels) if (only(r.idx)) for (const t of facts[r.idx]!) full[r.idx]!.add(t);
  };
  const fresh = () => rels.map((r) => new Rel(r.attrs.length));

  const ensureShared = (): Rel[] => {
    if (shared) return shared;
    ctx.full = fresh();
    seed(ctx.full, (i) => !dynamicRel.has(i));
    for (const s of strata) if (!s.dynamic) evalStratum(s, ctx);
    return (shared = ctx.full);
  };

  return {
    relations,
    run(input = {}) {
      const base = ensureShared();
      const mark = syms.mark();
      try {
        ctx.full = rels.map((r) => (dynamicRel.has(r.idx) ? new Rel(r.attrs.length) : base[r.idx]!));
        seed(ctx.full, (i) => dynamicRel.has(i));
        loadInput(input, rels, ctx.full, syms);
        for (const s of strata) if (s.dynamic) evalStratum(s, ctx);
        const out: Record<string, Tuple[]> = {};
        for (const r of rels) if (r.output) out[r.name] = decode(r, ctx.full[r.idx]!, syms);
        return out;
      } finally {
        ctx.full = [];
        ctx.delta = [];
        ctx.pend = [];
        syms.rollback(mark);
      }
    },
  };
}

const isConst = (e: Ex): boolean => e.k === 'c' || (e.k !== 'v' && e.k !== 'agg' && subs(e).every(isConst));
const subs = (e: Ex): Ex[] => (e.k === 'bin' ? [e.a, e.b] : e.k === 'neg' ? [e.a] : e.k === 'fn' ? e.args : []);

function constant(planner: Planner, e: Ex, rule: Rule): number {
  try {
    return planner.expr(e, rule)([]);
  } catch (err) {
    if (err instanceof DatalogError && err.file === undefined) throw new DatalogError(err.message, rule.pos.file, rule.pos.line);
    throw err;
  }
}

function loadInput(input: Readonly<Record<string, readonly Tuple[]>>, rels: RelInfo[], full: Rel[], syms: Syms): void {
  for (const [name, tuples] of Object.entries(input)) {
    const rel = rels.find((r) => r.name === name);
    if (!rel) throw new DatalogError(`facts for undeclared relation ${name}`);
    if (!rel.input) throw new DatalogError(`facts for ${name}, which is not an .input relation`);
    for (const t of tuples) {
      if (t.length !== rel.attrs.length) throw new DatalogError(`${name}: a fact has ${t.length} value(s), expected ${rel.attrs.length}`);
      full[rel.idx]!.add(
        t.map((v, i) => {
          if (rel.types[i] === 's') {
            if (typeof v !== 'string') throw new DatalogError(`${name}: attribute ${rel.attrs[i]!.name} is a symbol, got ${JSON.stringify(v)}`);
            return syms.id(v);
          }
          if (typeof v !== 'number' || !Number.isSafeInteger(v))
            throw new DatalogError(`${name}: attribute ${rel.attrs[i]!.name} is a number, got ${JSON.stringify(v)}`);
          return v;
        }),
      );
    }
  }
}

function decode(rel: RelInfo, data: Rel, syms: Syms): Tuple[] {
  const sym = rel.types.map((t) => t === 's');
  const rows: Value[][] = data.tuples.map((t) => t.map((v, i): Value => (sym[i] ? syms.strs[v]! : v)));
  return rows.sort((a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      return a[i]! < b[i]! ? -1 : 1;
    }
    return 0;
  });
}

// ---- stratification -------------------------------------------------------

function stratify(rels: RelInfo[], rules: Rule[], planner: Planner): Stratum[] {
  const n = rels.length;
  const deps = rules.map((r) => ruleDeps(r));
  const adj: number[][] = rels.map(() => []);
  rules.forEach((r, i) => {
    for (const d of deps[i]!) adj[r.rel]!.push(d.rel);
  });

  // Tarjan; components come out dependencies first.
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const comp = new Array<number>(n).fill(-1);
  const comps: number[][] = [];
  let counter = 0;
  const visit = (v: number): void => {
    index[v] = low[v] = counter++;
    stack.push(v);
    onStack[v] = true;
    for (const w of adj[v]!) {
      if (index[w]! < 0) {
        visit(w);
        low[v] = Math.min(low[v]!, low[w]!);
      } else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
    }
    if (low[v] === index[v]) {
      const c: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = false;
        comp[w] = comps.length;
        c.push(w);
      } while (w !== v);
      comps.push(c.sort((a, b) => a - b));
    }
  };
  for (let v = 0; v < n; v++) if (index[v]! < 0) visit(v);

  rules.forEach((r, i) => {
    for (const d of deps[i]!) {
      if (d.strict && comp[d.rel] === comp[r.rel]) {
        throw new DatalogError(
          `unstratifiable: ${cycle(rels, adj, comp, r.rel, d.rel)} (negation or aggregation inside a recursive cycle)`,
          d.pos.file,
          d.pos.line,
        );
      }
    }
  });

  const dynamicComp = new Array<boolean>(comps.length).fill(false);
  const strata: Stratum[] = [];
  comps.forEach((c, ci) => {
    const inComp = new Set(c);
    let dynamic = c.some((r) => rels[r]!.input);
    const own = rules.filter((r) => inComp.has(r.rel));
    for (const r of own) for (const d of ruleDeps(r)) if (!inComp.has(d.rel) && dynamicComp[comp[d.rel]!]) dynamic = true;
    dynamicComp[ci] = dynamic;
    const st: Stratum = { rels: c, base: [], rec: [], dynamic };
    for (const r of own) {
      const recAtoms: number[] = [];
      r.body.forEach((l, li) => {
        if (l.k === 'atom' && !l.neg && inComp.has(l.rel)) recAtoms.push(li);
      });
      if (recAtoms.length === 0) st.base.push(compileRule(planner, r, -1));
      else for (const li of recAtoms) st.rec.push({ c: compileRule(planner, r, li), deltaRel: (r.body[li] as { rel: number }).rel });
    }
    strata.push(st);
  });
  return strata;
}

/** `a -> !b -> ... -> a`: the strict edge `from → to` closed by a path back inside the component. */
function cycle(rels: RelInfo[], adj: number[][], comp: number[], from: number, to: number): string {
  const prev = new Map<number, number>([[to, -1]]);
  const queue = [to];
  while (queue.length > 0 && !prev.has(from)) {
    const v = queue.shift()!;
    for (const w of adj[v]!) {
      if (comp[w] === comp[from] && !prev.has(w)) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  // prev links lead from `from` back to `to`; walk them to list the way round.
  const way: string[] = [];
  for (let v = from; v !== -1; v = prev.get(v)!) way.push(rels[v]!.name);
  return `${rels[from]!.name} -> !${rels[to]!.name}` + (from === to ? '' : ' -> ' + way.reverse().slice(1).join(' -> '));
}

function compileRule(planner: Planner, rule: Rule, deltaAt: number): Compiled {
  const { ctx } = planner;
  const hr = rule.rel;
  const heads = rule.head.map((h) => planner.expr(h, rule));
  const n = heads.length;
  const need = new Set<number>();
  for (const h of rule.head) exSlots(h, need);
  const end: Fn = (f) => {
    const t = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const v = heads[i]!(f);
      if (v !== v) return;
      t[i] = v;
    }
    const full = ctx.full[hr]!;
    const key = full.keyFor(t);
    const pend = ctx.pend[hr]!;
    if (!full.set.has(key) && !pend.set.has(key)) pend.addKeyed(key, t);
  };
  const run = planner.body(rule, rule.body, [], deltaAt, need, end);
  const frame: Frame = new Array<number>(rule.names.length).fill(0);
  return { run, frame, rule };
}

function exec(c: Compiled): void {
  try {
    c.run(c.frame);
  } catch (e) {
    if (e instanceof DatalogError && e.file === undefined) throw new DatalogError(e.message, c.rule.pos.file, c.rule.pos.line);
    throw e;
  }
}

// ---- evaluation -----------------------------------------------------------

function evalStratum(st: Stratum, ctx: Ctx): void {
  const merge = (): void => {
    for (const r of st.rels) for (const t of ctx.pend[r]!.tuples) ctx.full[r]!.add(t);
  };
  const newPend = (): void => {
    for (const r of st.rels) ctx.pend[r] = new Rel(ctx.full[r]!.arity);
  };
  newPend();
  for (const c of st.base) exec(c);
  merge();
  if (st.rec.length === 0) return;
  // The facts and base results are the first delta of the recursion.
  for (const r of st.rels) {
    const d = new Rel(ctx.full[r]!.arity);
    for (const t of ctx.full[r]!.tuples) d.push(t);
    ctx.delta[r] = d;
  }
  for (;;) {
    if (st.rels.every((r) => ctx.delta[r]!.tuples.length === 0)) break;
    newPend();
    for (const { c, deltaRel } of st.rec) if (ctx.delta[deltaRel]!.tuples.length > 0) exec(c);
    merge();
    for (const r of st.rels) ctx.delta[r] = ctx.pend[r];
  }
}
