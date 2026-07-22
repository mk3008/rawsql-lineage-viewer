import type { Scalar } from './cases/acceptedCases';

export interface PositionalStatement {
  readonly mapping: readonly { readonly name: string; readonly position: number }[];
  readonly text: string;
  readonly values: readonly Scalar[];
}

/** Converts named placeholders to PostgreSQL positions without interpolating values. */
export function compileNamedParameters(
  sql: string,
  declaredNames: readonly string[],
  bindings: Readonly<Record<string, Scalar>>,
): PositionalStatement {
  const declared = new Set(declaredNames);
  const positions = new Map<string, number>();
  let text = '';

  for (let index = 0; index < sql.length;) {
    const quote = sql[index];
    if (quote === "'" || quote === '"') {
      const end = copyQuoted(sql, index, quote);
      text += sql.slice(index, end);
      index = end;
      continue;
    }
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index + 2);
      const boundary = end === -1 ? sql.length : end + 1;
      text += sql.slice(index, boundary);
      index = boundary;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) throw new Error('Unterminated SQL block comment.');
      text += sql.slice(index, end + 2);
      index = end + 2;
      continue;
    }
    if (sql[index] === '$') {
      const tag = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) throw new Error('Unterminated SQL dollar quote.');
        text += sql.slice(index, end + tag.length);
        index = end + tag.length;
        continue;
      }
    }
    const placeholder = sql.slice(index).match(/^:([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (placeholder && sql[index - 1] !== ':') {
      const name = placeholder[1];
      if (!declared.has(name)) throw new Error(`SQL placeholder :${name} is not declared.`);
      if (!Object.prototype.hasOwnProperty.call(bindings, name)) throw new Error(`SQL placeholder :${name} has no binding.`);
      if (!positions.has(name)) positions.set(name, positions.size + 1);
      text += `$${positions.get(name)}`;
      index += placeholder[0].length;
      continue;
    }
    text += sql[index];
    index += 1;
  }

  const unused = [...declared].filter((name) => !positions.has(name));
  if (unused.length > 0) throw new Error(`Declared SQL parameter(s) were not used: ${unused.join(', ')}`);
  const mapping = [...positions].map(([name, position]) => ({ name, position }));
  return { text, mapping, values: mapping.map(({ name }) => bindings[name]) };
}

function copyQuoted(sql: string, start: number, quote: string): number {
  for (let index = start + 1; index < sql.length; index += 1) {
    if (sql[index] !== quote) continue;
    if (sql[index + 1] === quote) {
      index += 1;
      continue;
    }
    return index + 1;
  }
  throw new Error('Unterminated SQL quoted value or identifier.');
}
