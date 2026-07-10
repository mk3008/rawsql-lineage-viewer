import { buildColumnDiagnosticPacket, type CandidateConcern, type ColumnDiagnosticPacket, type ColumnTarget } from './diagnostics';
import type { ProblemIntent } from './problemIntent';
import { analyzeSql } from './rawsqlAdapter';
import { parseSchemaFactsFromDdl, type DdlInput, type SchemaFacts } from './schemaFacts';

/** The only SQL mode used to diagnose the submitted statement. */
export type InvestigationAnalysisModeV1 = 'original';

export type InvestigationParameterOriginV1 =
  | 'investigation_key'
  | 'original_query_parameter'
  | 'derived_parameter'
  | 'environment_parameter'
  | 'unresolved_parameter';

export type InvestigationParameterStatusV1 = 'provided' | 'required' | 'unresolved';

export type InvestigationParameterUseV1 =
  | { analysisMode: InvestigationAnalysisModeV1; kind: 'original_analysis' }
  | { kind: 'probe'; probeId: string };

export interface InvestigationParameterV1 {
  /** A deterministic identifier within the plan. */
  id: string;
  name: string;
  origin: InvestigationParameterOriginV1;
  required: boolean;
  status: InvestigationParameterStatusV1;
  typeHint?: string;
  usedBy: InvestigationParameterUseV1[];
  value?: boolean | number | string | null;
}

export type UnresolvedParameterV1 = InvestigationParameterV1 & {
  origin: 'unresolved_parameter';
  status: 'unresolved';
};

export interface InvestigationTargetV1 {
  columnName: string;
  nodeId: string;
  symptom: string;
}

export interface CandidateConcernV1 {
  /** A deterministic identifier within the plan. */
  id: string;
  evidence: string[];
  hypothesis: string;
  limitations: string[];
  status: 'candidate';
}

export interface InvestigationDiagnosticV1 {
  code: string;
  message: string;
}

export interface InvestigationLimitationV1 {
  code: string;
  message: string;
}

export interface ProbeSpecV1 {
  /** A deterministic identifier within the plan. */
  id: string;
  confidence: 'high' | 'low' | 'medium' | 'possible' | 'unknown';
  hypothesis: string;
  kind: string;
  limitations: string[];
  nodeId: string;
  parameters: InvestigationParameterV1[];
  priority: number;
  priorityReasons: string[];
  question: string;
  readOnly: true;
  reason: string;
  sql: string;
}

export interface BlockedProbeV1 {
  /** A deterministic identifier within the plan. */
  id: string;
  code: string;
  reason: string;
  status: 'blocked';
}

export interface InvestigationPlanV1 {
  analysisMode: InvestigationAnalysisModeV1;
  blockedProbes: BlockedProbeV1[];
  candidateConcerns: CandidateConcernV1[];
  deferredProbes: ProbeSpecV1[];
  diagnostics: InvestigationDiagnosticV1[];
  kind: 'investigation-plan';
  limitations: InvestigationLimitationV1[];
  parameters: InvestigationParameterV1[];
  recommendedProbes: ProbeSpecV1[];
  target: InvestigationTargetV1;
  unresolvedParameters: UnresolvedParameterV1[];
  version: 1;
}

/** A supplied value that the planner may reference by name, but never inline in SQL. */
export interface InvestigationPlannerParameterInputV1 {
  name: string;
  origin: Exclude<InvestigationParameterOriginV1, 'unresolved_parameter'>;
  required?: boolean;
  typeHint?: string;
  value?: boolean | number | string | null;
}

/** Pure inputs to create an investigation plan from already-computed diagnostics. */
export interface InvestigationPlanInputV1 {
  /** Submitted SQL analyzed without rewriting or execution. */
  sql: string;
  target: ColumnTarget;
  symptom?: ProblemIntent;
  ddl?: DdlInput[];
  schemaFacts?: SchemaFacts;
  parameters?: InvestigationPlannerParameterInputV1[];
}

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*$/;
const PARAMETER_REFERENCE = /:([A-Za-z_][A-Za-z0-9_]*)/g;
const MAX_RECOMMENDED_PROBES = 3;
/** Used when callers do not describe a symptom explicitly. */
const DEFAULT_INVESTIGATION_SYMPTOM: ProblemIntent = 'logic_review';

/**
 * Produces a deterministic, non-conclusive plan from static lineage diagnostics.
 * This function does not analyze altered SQL or execute a probe.
 */
export function createInvestigationPlan(input: InvestigationPlanInputV1): InvestigationPlanV1 {
  const schemaFacts = input.schemaFacts ?? (input.ddl ? parseSchemaFactsFromDdl(input.ddl) : undefined);
  const symptom = input.symptom ?? DEFAULT_INVESTIGATION_SYMPTOM;
  const { lineage } = analyzeSql(input.sql, { analysisMode: 'original', optimizeConditions: false, schemaFacts });
  const packet = buildColumnDiagnosticPacket(lineage, input.target, { schemaFacts, symptom });
  return createInvestigationPlanFromDiagnosticPacket(packet, input.parameters, symptom);
}

/** @internal Test seam for planning behavior after the pure parser/diagnostics boundary. */
export function createInvestigationPlanFromDiagnosticPacket(
  packet: ColumnDiagnosticPacket,
  inputs: InvestigationPlannerParameterInputV1[] = [],
  symptom: string = DEFAULT_INVESTIGATION_SYMPTOM,
): InvestigationPlanV1 {
  const candidateConcerns = [...packet.candidateConcerns]
    .sort(compareConcerns)
    .map((concern, index) => toCandidateConcern(concern, index));
  const parameterEntries = buildParameters(inputs);
  const sourceByNodeId = new Map(packet.columnLineage.sourceLeaves.map((source) => [source.nodeId, source]));
  const recommendedProbes: ProbeSpecV1[] = [];
  const deferredProbes: ProbeSpecV1[] = [];
  const blockedProbes: BlockedProbeV1[] = [];

  for (const [index, concern] of [...packet.candidateConcerns].sort(compareConcerns).entries()) {
    const probeId = `probe:${slug(concern.kind)}:${String(index + 1).padStart(2, '0')}`;
    if (concern.kind !== 'where') {
      blockedProbes.push(blockedProbe(probeId, 'UNSUPPORTED_CONCERN_KIND', 'Only a single-relation WHERE predicate is supported for a standalone read-only probe.'));
      continue;
    }
    const influence = resolveWhereInfluence(concern, packet);
    if (!influence) {
      blockedProbes.push(blockedProbe(probeId, 'SAFE_PROBE_FRAGMENT_UNAVAILABLE', 'No parser-backed WHERE predicate is available for a safe read-only probe.'));
      continue;
    }
    if (new Set(influence.references.map((reference) => reference.nodeId)).size !== 1) {
      blockedProbes.push(blockedProbe(probeId, 'MULTI_RELATION_PREDICATE_UNSUPPORTED', 'The WHERE predicate references multiple relations and cannot be safely isolated as a standalone probe.'));
      continue;
    }
    if (hasQualifiedReference(influence.expressionSql)) {
      blockedProbes.push(blockedProbe(probeId, 'ALIAS_MAPPING_UNAVAILABLE', 'The WHERE predicate requires an original relation alias that cannot be reliably reconstructed for a standalone probe.'));
      continue;
    }
    const source = resolveProbeSource(concern, packet, sourceByNodeId);
    if (!source) {
      blockedProbes.push(blockedProbe(probeId, 'UNSUITABLE_PROBE_SOURCE', 'No supported physical source relation is available for a standalone read-only probe.'));
      continue;
    }
    const parameterNames = referencedParameters(influence.expressionSql);
    const probe = createProbe(probeId, concern, source.relation, source.nodeId, influence.expressionSql, index + 1, parameterNames, parameterEntries);
    if (recommendedProbes.length < MAX_RECOMMENDED_PROBES) {
      recommendedProbes.push(probe);
    } else {
      deferredProbes.push(probe);
    }
  }

  const parameters = [...parameterEntries.values()].sort((left, right) => left.id.localeCompare(right.id));
  const unresolvedParameters = parameters.filter(isUnresolvedParameter);
  return {
    analysisMode: 'original',
    blockedProbes,
    candidateConcerns,
    deferredProbes,
    diagnostics: [
      { code: 'original_sql_only', message: 'The plan uses only the original SQL lineage diagnostic packet.' },
      ...packet.diagnostics.map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message })),
    ],
    kind: 'investigation-plan',
    limitations: [
      { code: 'no_database_access', message: 'No database result was inspected; concerns remain hypotheses.' },
      { code: 'original_analysis_only', message: 'The planner does not rewrite or execute SQL.' },
      ...blockedProbes.map((probe) => ({ code: probe.code.toLowerCase(), message: probe.reason })),
    ],
    parameters,
    recommendedProbes,
    target: { columnName: packet.target.columnName, nodeId: packet.target.nodeId, symptom },
    unresolvedParameters,
    version: 1,
  };
}

function buildParameters(inputs: InvestigationPlannerParameterInputV1[]): Map<string, InvestigationParameterV1> {
  const result = new Map<string, InvestigationParameterV1>();
  for (const input of [...inputs].sort((left, right) => `${left.origin}:${left.name}`.localeCompare(`${right.origin}:${right.name}`))) {
    const hasValue = Object.prototype.hasOwnProperty.call(input, 'value');
    const origin = input.required && !hasValue ? 'unresolved_parameter' : input.origin;
    const id = `parameter:${origin}:${input.name}`;
    result.set(id, {
      id,
      name: input.name,
      origin,
      required: input.required ?? false,
      status: origin === 'unresolved_parameter' ? 'unresolved' : hasValue ? 'provided' : 'required',
      ...(input.typeHint ? { typeHint: input.typeHint } : {}),
      usedBy: input.origin === 'original_query_parameter' ? [{ analysisMode: 'original', kind: 'original_analysis' }] : [],
      ...(hasValue ? { value: input.value } : {}),
    });
  }
  return result;
}

function createProbe(
  id: string,
  concern: CandidateConcern,
  source: string,
  sourceNodeId: string,
  evidence: string,
  priority: number,
  parameterNames: string[],
  parameterEntries: Map<string, InvestigationParameterV1>,
): ProbeSpecV1 {
  const parameters = parameterNames.map((name) => ensureProbeParameter(name, id, parameterEntries));
  return {
    confidence: concern.confidence,
    hypothesis: `${concern.reason} This remains a candidate concern until the read-only probe is evaluated.`,
    id,
    kind: 'candidate_row_count',
    limitations: ['The query is a proposed read-only SELECT and has not been executed.', 'Parameter values are referenced by placeholders and are never inlined.'],
    nodeId: sourceNodeId,
    parameters,
    priority,
    priorityReasons: ['Directly tests static SQL evidence for a candidate concern.'],
    question: `How many rows in ${source} satisfy the candidate condition?`,
    readOnly: true,
    reason: concern.reason,
    sql: `SELECT COUNT(*) AS candidate_rows FROM ${source} WHERE (${evidence})`,
  };
}

function ensureProbeParameter(name: string, probeId: string, entries: Map<string, InvestigationParameterV1>): InvestigationParameterV1 {
  const entry = [...entries.values()].find((parameter) => parameter.name === name)
    ?? createUnresolvedParameter(name, entries);
  if (!entry.usedBy.some((use) => use.kind === 'probe' && use.probeId === probeId)) {
    entry.usedBy.push({ kind: 'probe', probeId });
  }
  return entry;
}

function createUnresolvedParameter(name: string, entries: Map<string, InvestigationParameterV1>): InvestigationParameterV1 {
  const id = `parameter:unresolved_parameter:${name}`;
  const parameter: InvestigationParameterV1 = { id, name, origin: 'unresolved_parameter', required: true, status: 'unresolved', usedBy: [] };
  entries.set(id, parameter);
  return parameter;
}

function resolveProbeSource(
  concern: CandidateConcern,
  packet: ColumnDiagnosticPacket,
  sourceByNodeId: Map<string, ColumnDiagnosticPacket['columnLineage']['sourceLeaves'][number]>,
): { nodeId: string; relation: string } | undefined {
  const referenceNodeId = concern.influenceIds.length > 0
    ? packet.rowLineage.influences.find((influence) => influence.id === concern.influenceIds[0])?.references[0]?.nodeId
    : undefined;
  const source = referenceNodeId ? sourceByNodeId.get(referenceNodeId) : packet.columnLineage.sourceLeaves[0];
  const value = source?.nodeLabel;
  return value && source?.nodeType === 'table' && SQL_IDENTIFIER.test(value) ? { nodeId: source.nodeId, relation: value } : undefined;
}

function resolveWhereInfluence(concern: CandidateConcern, packet: ColumnDiagnosticPacket): { expressionSql: string; references: Array<{ nodeId: string }> } | undefined {
  const influences = new Map(packet.rowLineage.influences.map((influence) => [influence.id, influence]));
  for (const id of concern.influenceIds) {
    const influence = influences.get(id);
    if (influence?.kind === 'where' && typeof influence.expressionSql === 'string' && isSafePredicate(influence.expressionSql)) {
      return { expressionSql: influence.expressionSql, references: influence.references };
    }
  }
  return undefined;
}

function toCandidateConcern(concern: CandidateConcern, index: number): CandidateConcernV1 {
  return {
    evidence: [...concern.evidence],
    hypothesis: `${concern.reason} This is a candidate concern, not a conclusion.`,
    id: `concern:${slug(concern.kind)}:${String(index + 1).padStart(2, '0')}`,
    limitations: ['No database result was inspected.'],
    status: 'candidate',
  };
}

function compareConcerns(left: CandidateConcern, right: CandidateConcern): number {
  return `${left.kind}\u0000${left.scopeId}\u0000${left.evidence.join('\u0000')}`.localeCompare(`${right.kind}\u0000${right.scopeId}\u0000${right.evidence.join('\u0000')}`);
}

function referencedParameters(sql: string): string[] {
  return [...sql.matchAll(PARAMETER_REFERENCE)].map((match) => match[1]).filter((name, index, names) => names.indexOf(name) === index).sort();
}

function isSafePredicate(sql: string): boolean {
  return sql.trim().length > 0
    && !/[;]|--|\/\*/.test(sql)
    && !/(?:=|<>|!=|<=|>=|<|>|\+|-|\*|\/|\b(?:and|or|not|is|in|like|between))\s*$/i.test(sql);
}

function hasQualifiedReference(sql: string): boolean {
  return /\b[A-Za-z_][A-Za-z0-9_$]*\s*\./.test(sql);
}

function blockedProbe(id: string, code: string, reason: string): BlockedProbeV1 {
  return { code, id, reason, status: 'blocked' };
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'unknown';
}

function isUnresolvedParameter(parameter: InvestigationParameterV1): parameter is UnresolvedParameterV1 {
  return parameter.origin === 'unresolved_parameter' && parameter.status === 'unresolved';
}
