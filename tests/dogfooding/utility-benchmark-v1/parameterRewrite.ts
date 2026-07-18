import { SqlTokenizer, TokenType, type Lexeme } from 'rawsql-ts';

export interface SubmittedProbeStatement {
  parameterNames: string[];
  text: string;
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function encodeBindingKey(scenarioId: string, parameterName: string): string {
  return JSON.stringify([scenarioId, parameterName]);
}

export function collectProbeParameterNames(source: string): string[] {
  return parameterLexemes(source).map(({ name }) => name);
}

export function buildSubmittedProbeStatement(source: string, declaredParameterNames: string[]): SubmittedProbeStatement {
  const declaredPositions = new Map<string, number>();
  for (const name of declaredParameterNames) {
    if (declaredPositions.has(name)) throw benchmarkError('BENCHMARK_PARAMETER_DUPLICATE', `Duplicate benchmark parameter definition: ${name}`);
    declaredPositions.set(name, declaredPositions.size);
  }

  const lexemes = parameterLexemes(source);
  const usedNames = [...new Set(lexemes.map(({ name }) => name))]
    .sort((left, right) => (declaredPositions.get(left) ?? Number.MAX_SAFE_INTEGER) - (declaredPositions.get(right) ?? Number.MAX_SAFE_INTEGER));
  const usedPositions = new Map(usedNames.map((name, index) => [name, index + 1]));
  for (const name of usedNames) {
    if (!declaredPositions.has(name)) throw benchmarkError('BENCHMARK_PARAMETER_UNDECLARED', `Undeclared benchmark SQL parameter: ${name}`);
  }

  let cursor = 0;
  let rewritten = '';
  for (const { lexeme, name } of lexemes) {
    const position = lexeme.position;
    if (!position || source.slice(position.startPosition, position.endPosition) !== lexeme.value) {
      throw benchmarkError('BENCHMARK_PARAMETER_POSITION_UNAVAILABLE', `Missing source position for benchmark SQL parameter: ${name}`);
    }
    rewritten += source.slice(cursor, position.startPosition);
    rewritten += `$${usedPositions.get(name)}`;
    cursor = position.endPosition;
  }
  rewritten += source.slice(cursor);

  return {
    parameterNames: usedNames,
    text: `SELECT * FROM (${rewritten.replace(/;\s*$/, '')}) AS benchmark_probe LIMIT 100`,
  };
}

export function buildSubmittedProbeSql(source: string, declaredParameterNames: string[]): string {
  return buildSubmittedProbeStatement(source, declaredParameterNames).text;
}

function parameterLexemes(source: string): Array<{ lexeme: Lexeme; name: string }> {
  return new SqlTokenizer(source).readLexemes()
    .filter((lexeme) => (lexeme.type & TokenType.Parameter) !== 0)
    .map((lexeme) => {
      const match = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(lexeme.value);
      if (!match) throw benchmarkError('BENCHMARK_PARAMETER_STYLE_UNSUPPORTED', `Unsupported benchmark SQL parameter token: ${lexeme.value}`);
      return { lexeme, name: match[1] };
    });
}

function benchmarkError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
