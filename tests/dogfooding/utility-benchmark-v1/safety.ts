import { BinarySelectQuery, DeleteQuery, FunctionSource, InsertQuery, MergeQuery, ParenSource, SimpleSelectQuery, SqlParser, SubQuerySource, TableSource, UpdateQuery } from 'rawsql-ts';

export type CandidateConcern = { id: string; mechanism?: string };
export type EvidenceChecklistItem = { kind: string; mechanism?: string; candidateConcernIds?: string[]; condition?: string };
export type Probe = { id: string; artifactKind?: string; sql: string; parameters: Array<{ name: string; status: string }>; staticSafetyEvidence: { statementClassification: string; confidence: string; version: number }; interpretation?: { supportsCandidateConcernIds?: string[]; weakensCandidateConcernIds?: string[]; observationRules?: unknown[] } };
export type Plan = { recommendedProbes: Probe[]; unresolvedParameters: Array<{ name: string }>; candidateConcerns?: CandidateConcern[]; nextEvidenceChecklist?: EvidenceChecklistItem[]; sourceSql?: string };
export type Scalar = string | number | boolean | null;

function supported(q: unknown): boolean {
  if (q instanceof BinarySelectQuery) return supported(q.left) && supported(q.right);
  if (!(q instanceof SimpleSelectQuery)) return false;
  if (!(q.withClause?.tables ?? []).every(t => supportedCte(t.query))) return false;
  return (q.fromClause?.getSources() ?? []).every(s => source(s.datasource));
}
function supportedCte(q: unknown): boolean {
  if (q instanceof InsertQuery || q instanceof UpdateQuery || q instanceof DeleteQuery || q instanceof MergeQuery) return false;
  return supported(q);
}
function source(s: unknown): boolean {
  if (s instanceof TableSource || s instanceof FunctionSource) return true;
  if (s instanceof SubQuerySource) return supported(s.query);
  if (s instanceof ParenSource) return source(s.source);
  return false;
}
export function validateProbe(plan: Plan, probe: Probe, bindings: Record<string, Scalar>): void {
  if (!plan.recommendedProbes.some(p => p.id === probe.id) || probe.artifactKind !== 'investigation_probe') throw new Error('PROBE_NOT_RECOMMENDED');
  if (plan.unresolvedParameters.length || probe.parameters.some(p => p.status === 'unresolved')) throw new Error('PARAMETER_UNRESOLVED');
  let ast; try { ast = SqlParser.parse(probe.sql); } catch { throw new Error('PROBE_PARSE_FAILED'); }
  if (!supported(ast) || (probe.sql.match(/;/g) ?? []).length > 1) throw new Error('PROBE_AST_UNSUPPORTED');
  if (/\b(for\s+(update|share)|pg_sleep|dblink|lo_export|copy|nextval|set_config)\b/i.test(probe.sql)) throw new Error('PROBE_EFFECT_UNSAFE');
  const names = [...probe.sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)\b/g)].map(m => m[1]);
  for (const name of names) if (!probe.parameters.some(p => p.name === name) || !Object.hasOwn(bindings, name)) throw new Error('BINDING_MISMATCH');
}
