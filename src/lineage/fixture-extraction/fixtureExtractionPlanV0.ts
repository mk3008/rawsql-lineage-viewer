import type { DdlInput, SchemaFacts } from '../schemaFacts';

export interface FixtureExtractionInputV0 {
  readonly sql: string;
  readonly ddl?: readonly DdlInput[];
  readonly schemaFacts?: SchemaFacts;
  readonly targetId?: string;
  readonly reproductionKey: FixtureExtractionReproductionKeyInputV0;
}

export interface FixtureExtractionReproductionKeyInputV0 {
  readonly parameterNames: readonly string[];
  readonly rootRelation?: string;
  readonly rootColumns?: readonly string[];
}

export type FixtureExtractionInputErrorCodeV0 =
  | 'INPUT_SHAPE_INVALID'
  | 'VALUE_BEARING_INPUT_FORBIDDEN';

export class FixtureExtractionInputErrorV0 extends Error {
  readonly code: FixtureExtractionInputErrorCodeV0;

  constructor(code: FixtureExtractionInputErrorCodeV0) {
    super(code === 'VALUE_BEARING_INPUT_FORBIDDEN'
      ? 'Value-bearing input is forbidden for fixture extraction.'
      : 'Fixture extraction input has an invalid shape.');
    this.name = 'FixtureExtractionInputErrorV0';
    this.code = code;
  }
}

export type FixtureExtractionPlanStatusV0 = 'ready' | 'partial' | 'blocked';

export type FixtureExtractionBlockedCodeV0 =
  | 'SQL_PARSE_UNSUPPORTED'
  | 'DML_STATEMENT_UNSUPPORTED'
  | 'RETURNING_UNSUPPORTED'
  | 'DML_CTE_UNSUPPORTED'
  | 'RECURSIVE_CTE_UNSUPPORTED'
  | 'ENVIRONMENT_STATE_UNSUPPORTED'
  | 'VOLATILE_SOURCE_UNSUPPORTED'
  | 'UNRESOLVED_WILDCARD'
  | 'ROOT_RELATION_UNRESOLVED'
  | 'RELATION_UNRESOLVED'
  | 'COLUMN_REFERENCE_AMBIGUOUS'
  | 'REPRODUCTION_KEY_REQUIRED'
  | 'REPRODUCTION_KEY_AMBIGUOUS'
  | 'SCHEMA_FACTS_REQUIRED'
  | 'FOREIGN_KEY_AMBIGUOUS'
  | 'NON_EQUALITY_JOIN_UNSUPPORTED'
  | 'JOIN_BOUNDARY_UNPROVEN'
  | 'PARAMETER_PROPAGATION_UNPROVEN'
  | 'CAPTURE_BOUNDARY_UNBOUNDED';

export type FixtureExtractionRequiredFactV0 =
  | 'function volatility metadata'
  | 'missing foreign key'
  | 'relation identity'
  | 'root key column'
  | 'schema columns'
  | 'static SQL text'
  | 'transaction-independent semantics';

export interface FixtureExtractionPlanV0 {
  readonly kind: 'fixture-extraction-plan';
  readonly version: 0;
  readonly status: FixtureExtractionPlanStatusV0;
  readonly source: FixtureExtractionSourceV0;
  readonly reproductionKey: FixtureExtractionReproductionKeyV0;
  readonly sourceEvidence: readonly FixtureExtractionSourceEvidenceV0[];
  readonly steps: readonly FixtureExtractionStepV0[];
  readonly suggestedCaptureOrder: readonly string[];
  readonly suggestedLoadOrder: readonly string[];
  readonly blockedReasons: readonly FixtureExtractionBlockedReasonV0[];
  readonly limitations: readonly FixtureExtractionLimitationV0[];
}

export interface FixtureExtractionSourceV0 {
  readonly analysisMode: 'original';
  readonly hashAlgorithm: 'sha256';
  readonly sqlHash: string;
  readonly targetId?: string;
}

export interface FixtureExtractionReproductionKeyV0 {
  readonly parameterNames: readonly string[];
  readonly rootRelation?: string;
  readonly rootRelationOccurrenceId?: string;
  readonly rootColumns: readonly string[];
  readonly columnParameterMappings: readonly FixtureExtractionColumnParameterMappingV0[];
  readonly sourceEvidenceIds: readonly string[];
  readonly status: 'resolved' | 'ambiguous' | 'blocked';
}

export interface FixtureExtractionColumnParameterMappingV0 {
  readonly parameterName: string;
  readonly rootColumn: string;
}

export type FixtureExtractionSourceEvidenceKindV0 =
  | 'parser_ast'
  | 'target_discovery'
  | 'lineage_node'
  | 'lineage_edge'
  | 'lineage_scope'
  | 'where_condition'
  | 'join_condition'
  | 'exists_condition'
  | 'schema_table'
  | 'schema_primary_key'
  | 'schema_unique_key'
  | 'schema_foreign_key'
  | 'schema_diagnostic';

export interface FixtureExtractionSourceEvidenceV0 {
  readonly id: string;
  readonly kind: FixtureExtractionSourceEvidenceKindV0;
  readonly sourceId: string;
  readonly sourcePath?: string;
}

export type FixtureExtractionPredicateDerivationV0 =
  | 'root_predicate'
  | 'join_key_propagation'
  | 'exists_dependency'
  | 'foreign_key_dependency';

export interface FixtureExtractionStepBaseV0 {
  readonly id: string;
  readonly relationName: string;
  readonly relationOccurrenceId: string;
  readonly artifactKind: 'fixture_extraction_query';
  readonly dependsOnStepIds: readonly string[];
  readonly loadAfterStepIds: readonly string[];
  readonly predicateDerivation: FixtureExtractionPredicateDerivationV0;
  readonly sourceEvidenceIds: readonly string[];
  readonly captureColumns: FixtureExtractionCaptureColumnsV0;
  readonly resultExpectation: FixtureExtractionResultExpectationV0;
}

export interface FixtureExtractionBoundedStepV0 extends FixtureExtractionStepBaseV0 {
  readonly sql: string;
  readonly parameterNames: readonly string[];
  readonly boundary: FixtureExtractionBoundedBoundaryV0;
  readonly blockedReasonCodes: readonly [];
}

export interface FixtureExtractionUnknownStepV0 extends FixtureExtractionStepBaseV0 {
  readonly sql: null;
  readonly parameterNames: readonly string[];
  readonly boundary: FixtureExtractionUnknownBoundaryV0;
  readonly blockedReasonCodes: readonly FixtureExtractionBlockedCodeV0[];
}

export type FixtureExtractionStepV0 = FixtureExtractionBoundedStepV0 | FixtureExtractionUnknownStepV0;

export interface FixtureExtractionBoundedBoundaryV0 {
  readonly status: 'bounded';
  readonly reason:
    | 'root_key_parameter_equality'
    | 'direct_key_equality_propagation'
    | 'correlated_exists_key_equality'
    | 'nested_foreign_key_subquery';
  readonly hopCount: 0 | 1 | 2;
  readonly relationColumns: readonly string[];
  readonly parameterNames: readonly string[];
  readonly sourceEvidenceIds: readonly string[];
}

export interface FixtureExtractionUnknownBoundaryV0 {
  readonly status: 'unknown';
  readonly reason: 'unproven';
  readonly attemptedHopCount?: number;
  readonly reasonCodes: readonly FixtureExtractionBlockedCodeV0[];
  readonly sourceEvidenceIds: readonly string[];
}

export type FixtureExtractionBoundaryV0 = FixtureExtractionBoundedBoundaryV0 | FixtureExtractionUnknownBoundaryV0;

export type FixtureExtractionCaptureColumnsV0 =
  | { readonly mode: 'all_columns' }
  | { readonly mode: 'ddl_columns'; readonly columnNames: readonly string[] };

export type FixtureExtractionResultExpectationV0 =
  | { readonly kind: 'rows_may_be_present'; readonly note: null }
  | {
    readonly kind: 'empty_result_required';
    readonly note: 'The required reproduction state may be an empty result for this relation.';
  };

export interface FixtureExtractionBlockedReasonV0 {
  readonly code: FixtureExtractionBlockedCodeV0;
  readonly message: string;
  readonly requiredFacts: readonly FixtureExtractionRequiredFactV0[];
  readonly sourceEvidenceIds: readonly string[];
  readonly affectedStepIds: readonly string[];
}

export type FixtureExtractionLimitationCodeV0 =
  | 'STATIC_ONLY_NO_EXECUTION'
  | 'SENSITIVE_COLUMN_POLICY_NOT_EVALUATED'
  | 'GENERATED_IDENTITY_LOADING_OUTSIDE_POC'
  | 'LARGE_OBJECT_MIGRATION_OUTSIDE_POC'
  | 'TWO_HOP_PROPAGATION_LIMIT'
  | 'PARTIAL_PLAN_INCOMPLETE';

export interface FixtureExtractionLimitationV0 {
  readonly code: FixtureExtractionLimitationCodeV0;
  readonly message: string;
  readonly appliesToStepIds: readonly string[];
}

/** Produces the contract's canonical, code-unit-ordered JSON representation. */
export function canonicalFixtureExtractionPlanJsonV0(plan: FixtureExtractionPlanV0): string {
  return JSON.stringify(sortCanonicalValue(plan));
}

function sortCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort(compareCodeUnits)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => [key, sortCanonicalValue((value as Record<string, unknown>)[key])]));
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
