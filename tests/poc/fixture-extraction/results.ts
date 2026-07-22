import type { Scalar } from './cases/acceptedCases';

export interface StructuredResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly Scalar[])[];
}

export interface StructuredComparison {
  readonly columnNamesMatch: boolean;
  readonly duplicateRowsPreserved: boolean;
  readonly extraRows: readonly string[];
  readonly match: boolean;
  readonly missingRows: readonly string[];
  readonly nullsPreserved: boolean;
  readonly ordered: boolean;
  readonly rowCountMatch: boolean;
  readonly scalarValuesMatch: boolean;
  readonly sourceRowCount: number;
  readonly targetRowCount: number;
}

export function compareStructuredResults(
  source: StructuredResult,
  target: StructuredResult,
  ordered: boolean,
): StructuredComparison {
  const columnsMatch = JSON.stringify(source.columns) === JSON.stringify(target.columns);
  const sourceKeys = source.rows.map(rowKey);
  const targetKeys = target.rows.map(rowKey);
  const rowCountMatch = sourceKeys.length === targetKeys.length;
  const sequenceMatch = ordered
    ? JSON.stringify(sourceKeys) === JSON.stringify(targetKeys)
    : JSON.stringify([...sourceKeys].sort(compareCodeUnits)) === JSON.stringify([...targetKeys].sort(compareCodeUnits));
  const missingRows = multisetDifference(sourceKeys, targetKeys);
  const extraRows = multisetDifference(targetKeys, sourceKeys);
  const nullsPreserved = countNulls(source.rows) === countNulls(target.rows);
  const duplicateRowsPreserved = duplicateCount(sourceKeys) === duplicateCount(targetKeys);
  const scalarValuesMatch = sequenceMatch && missingRows.length === 0 && extraRows.length === 0;

  return {
    columnNamesMatch: columnsMatch,
    duplicateRowsPreserved,
    extraRows,
    match: columnsMatch && rowCountMatch && scalarValuesMatch && nullsPreserved && duplicateRowsPreserved,
    missingRows,
    nullsPreserved,
    ordered,
    rowCountMatch,
    scalarValuesMatch,
    sourceRowCount: source.rows.length,
    targetRowCount: target.rows.length,
  };
}

function multisetDifference(left: readonly string[], right: readonly string[]): string[] {
  const remaining = counts(right);
  const difference: string[] = [];
  for (const key of left) {
    const count = remaining.get(key) ?? 0;
    if (count === 0) difference.push(key);
    else remaining.set(key, count - 1);
  }
  return difference.sort(compareCodeUnits);
}

function counts(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  values.forEach((value) => result.set(value, (result.get(value) ?? 0) + 1));
  return result;
}

function duplicateCount(values: readonly string[]): number {
  return [...counts(values).values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function countNulls(rows: readonly (readonly Scalar[])[]): number {
  return rows.reduce((total, row) => total + row.filter((value) => value === null).length, 0);
}

function rowKey(row: readonly Scalar[]): string {
  return JSON.stringify(row.map((value) => value === null ? ['null'] : [typeof value, value]));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
