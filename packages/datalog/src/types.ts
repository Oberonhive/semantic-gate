// The engine's public types and error; index.ts re-exports them.

export type Value = string | number;
export type Tuple = readonly Value[];

export interface Attribute {
  name: string;
  type: 'symbol' | 'number';
}

export interface RelationDecl {
  name: string;
  attributes: readonly Attribute[];
  input: boolean;
  output: boolean;
}

export interface CompileOptions {
  /** Source text of a file named by the entry or an `#include` (paths as written, resolved by the caller). */
  read(path: string): string;
  /** Macros defined before the first line, like `souffle -D`. */
  defines?: Readonly<Record<string, string>>;
}

export interface Program {
  readonly relations: ReadonlyMap<string, RelationDecl>;
  /** Evaluate to fixpoint. `facts` may only name `.input` relations; every `.output` relation is returned, sorted. */
  run(facts?: Readonly<Record<string, readonly Tuple[]>>): Record<string, Tuple[]>;
}

/** A compile or run error; `file`/`line` locate it in the original sources. */
export class DatalogError extends Error {
  readonly file: string | undefined;
  readonly line: number | undefined;
  constructor(message: string, file?: string, line?: number) {
    super(file === undefined ? message : `${file}:${line ?? 0}: ${message}`);
    this.file = file;
    this.line = line;
  }
}
