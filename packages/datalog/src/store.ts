/**
 * The engine's data: interned symbols and relations. Symbols are small
 * integers inside the engine (so a tuple is an array of numbers, hashable and
 * comparable without looking at text); only the functors and the host
 * boundary see strings.
 */

export class Syms {
  strs: string[] = [];
  /** UTF-8 length per symbol, filled on demand (Soufflé's strlen/substr count bytes). */
  blen: number[] = [];
  private map = new Map<string, number>();

  id(s: string): number {
    let i = this.map.get(s);
    if (i === undefined) {
      i = this.strs.length;
      this.strs.push(s);
      this.map.set(s, i);
    }
    return i;
  }

  mark(): number {
    return this.strs.length;
  }

  /** Forget symbols interned since `mark` — a run's strings must not accumulate in a long-lived program. */
  rollback(mark: number): void {
    for (let i = mark; i < this.strs.length; i++) this.map.delete(this.strs[i]!);
    this.strs.length = mark;
    if (this.blen.length > mark) this.blen.length = mark;
  }
}

class Index {
  map = new Map<number | string, number[][]>();
  cols: readonly number[];
  constructor(cols: readonly number[]) {
    this.cols = cols;
  }

  add(t: number[]): void {
    const k = keyOf(t, this.cols);
    const b = this.map.get(k);
    if (b === undefined) this.map.set(k, [t]);
    else b.push(t);
  }
}

/** Index key of the given columns; the one definition the join steps must agree with. */
export function keyOf(t: readonly number[], cols: readonly number[]): number | string {
  const n = cols.length;
  if (n === 1) return t[cols[0]!]!;
  if (n === 2) return t[cols[0]!]! + ',' + t[cols[1]!]!;
  let s = '' + t[cols[0]!]!;
  for (let i = 1; i < n; i++) s += ',' + t[cols[i]!]!;
  return s;
}

export class Rel {
  tuples: number[][] = [];
  set = new Set<number | string>();
  private idx = new Map<number, Index>();
  private idxList: Index[] = [];

  readonly arity: number;
  constructor(arity: number) {
    this.arity = arity;
  }

  keyFor(t: readonly number[]): number | string {
    const n = this.arity;
    if (n === 1) return t[0]!;
    if (n === 0) return 0;
    if (n === 2) return t[0]! + ',' + t[1]!;
    return t.join(',');
  }

  add(t: number[]): boolean {
    const k = this.keyFor(t);
    if (this.set.has(k)) return false;
    this.set.add(k);
    this.push(t);
    return true;
  }

  addKeyed(k: number | string, t: number[]): void {
    this.set.add(k);
    this.push(t);
  }

  /** Append without the duplicate check — for a delta that is a copy of a set. */
  push(t: number[]): void {
    this.tuples.push(t);
    for (const ix of this.idxList) ix.add(t);
  }

  /** The tuples whose `cols` hash to `key`; the index is built the first time it is asked for. */
  lookup(mask: number, cols: readonly number[], key: number | string): number[][] | undefined {
    let ix = this.idx.get(mask);
    if (ix === undefined) {
      ix = new Index(cols);
      for (const t of this.tuples) ix.add(t);
      this.idx.set(mask, ix);
      this.idxList.push(ix);
    }
    return ix.map.get(key);
  }
}
