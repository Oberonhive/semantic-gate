/**
 * @semantic-gate/datalog — a Soufflé-subset Datalog engine, pure TypeScript.
 *
 * It exists so that one semantic layer written in Datalog (semtrans) runs in
 * every host the product targets — browser, node, and behind the native gate
 * — where Soufflé itself cannot. The language is a strict subset of Soufflé,
 * so any program this engine accepts also runs under `souffle` with the same
 * result; Soufflé is the reference this engine is checked against.
 *
 * The subset (anything else is a compile error naming file and line):
 * - `.decl r(a:symbol, b:number)`; `.input r` / `.output r` with any
 *   parenthesised I/O parameters, which are ignored;
 * - facts and rules with one head; `_`; negation `!r(...)` (stratified);
 *   constraints `= != < <= > >=` (ordering on numbers and, lexicographically,
 *   on symbols); arithmetic `+ - * / %` on numbers; expressions in heads;
 * - functors `cat(a, b, ...)`, `to_string(n)`, `to_number(s)`, `strlen(s)`,
 *   `substr(s, i, n)`, and the constraints `contains(sub, s)`,
 *   `match(regex, s)`;
 * - aggregates `count : { body }`, `sum E : { body }`, `min E : { body }`,
 *   `max E : { body }`, correlated through variables bound outside;
 * - preprocessor: `#include "file"`, `#define NAME text`, function-like
 *   `#define F(a, b) text`, `#undef`, `#ifdef`/`#ifndef`/`#else`/`#endif`;
 * - comments `//` and `/* *\/`.
 *
 * Where Soufflé is inconsistent, crashes, or would emit an invalid string, this
 * engine refuses at compile time or throws at run time instead of imitating it:
 * an aggregate nested in an aggregate, a variable that is both aggregated
 * (`sum x : {…}`) and bound outside it, `substr` cutting a multi-byte
 * character, division by zero, a non-numeric `to_number`, and results beyond
 * ±2^53 (`number` is a JS safe integer, not Soufflé's 64 bits). `#include`
 * resolves against the including file's directory, then as written.
 *
 * A program is compiled once and run many times (strata that cannot see an
 * `.input` relation are evaluated once and shared); each run starts from the
 * program's own facts plus the host's input facts and returns every output
 * relation with its tuples sorted, so results never depend on evaluation
 * order.
 */

import { build } from './engine.ts';
import type { CompileOptions, Program } from './types.ts';

export { DatalogError } from './types.ts';
export type { Attribute, CompileOptions, Program, RelationDecl, Tuple, Value } from './types.ts';

export function compile(entry: string, options: CompileOptions): Program {
  return build(entry, options);
}
