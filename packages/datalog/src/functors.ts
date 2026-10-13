/**
 * String functors with Soufflé's semantics: `strlen` and `substr` count UTF-8
 * bytes, `to_number` is strtoll-like, symbols order by code point. Where
 * Soufflé would produce an invalid string or crash, this throws instead.
 */
import { DatalogError } from './types.ts';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const ASCII = /^[\x00-\x7f]*$/;
const SURROGATE = /[\ud800-\udfff]/;

export function utf8Length(s: string): number {
  if (ASCII.test(s)) return s.length;
  return enc.encode(s).length;
}

export function substr(s: string, i: number, n: number): string {
  const len = ASCII.test(s) ? s.length : -1;
  if (len >= 0) {
    // Soufflé: a start past the end (or negative) is "", a negative length means "to the end".
    if (i < 0 || i > len) return '';
    return n < 0 ? s.slice(i) : s.substr(i, n);
  }
  const b = enc.encode(s);
  if (i < 0 || i > b.length) return '';
  try {
    return dec.decode(n < 0 ? b.subarray(i) : b.subarray(i, i + n));
  } catch {
    throw new DatalogError(`substr(${JSON.stringify(s)}, ${i}, ${n}) cuts a multi-byte character`);
  }
}

const NUMBER = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)/;

export function toNumber(s: string): number {
  const m = NUMBER.exec(s);
  if (!m) throw new DatalogError(`to_number(${JSON.stringify(s)}): not a number`);
  const d = m[2]!;
  const v = /^0[xX]/.test(d) ? parseInt(d, 16) : /^0[bB]/.test(d) ? parseInt(d.slice(2), 2) : Number(d);
  if (!Number.isSafeInteger(v)) throw new DatalogError(`to_number(${JSON.stringify(s)}): beyond 2^53`);
  return m[1] === '-' ? -v : v;
}

/** `<` on symbols: by code point (= Soufflé's byte order on UTF-8), not by UTF-16 unit. */
export function symLess(a: string, b: string): boolean {
  if (!SURROGATE.test(a) && !SURROGATE.test(b)) return a < b;
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    if (x[i] !== y[i]) return x[i]!.codePointAt(0)! < y[i]!.codePointAt(0)!;
  }
  return x.length < y.length;
}

const regexes = new Map<string, RegExp>();

/** `match(re, s)`: the whole of `s` must match (std::regex_match). */
export function regexMatch(re: string, s: string): boolean {
  let r = regexes.get(re);
  if (r === undefined) {
    try {
      r = new RegExp(`^(?:${re})$`);
    } catch {
      throw new DatalogError(`match: invalid regular expression ${JSON.stringify(re)}`);
    }
    if (regexes.size > 512) regexes.clear();
    regexes.set(re, r);
  }
  return r.test(s);
}
