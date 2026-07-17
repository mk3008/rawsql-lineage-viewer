export interface McpWorkflowEvidenceV1 {
  boundaryClarity: 'contract_mismatch' | 'explicit_static_stages' | 'high_level_static_contract';
  callCount: number;
  completed: boolean;
  errorLocalization: 'analysis' | 'none' | 'plan_creation' | 'preparation' | 'target_discovery';
  intermediateJsonBytes: number;
  selectionOutcome: 'failed' | 'plan_created' | 'selection_required';
}

export interface TargetDiscoveryScenarioEvidenceV1 {
  ambiguityHandling: 'explicit_before_planning' | 'not_present';
  composable: McpWorkflowEvidenceV1;
  highLevel: McpWorkflowEvidenceV1;
  kind: 'target-discovery-workflow-evidence';
  realLlmToolSelection: 'UNCONFIRMED';
  scenarioId: string;
  version: 1;
}

type StructuredToolResult = { isError?: boolean; structuredContent?: unknown };

/**
 * Measures actual static MCP response shapes from the same unknown-target
 * starting input. It does not execute SQL, ingest results, or infer how a real
 * LLM would choose tools.
 */
export function measureTargetDiscoveryWorkflows(input: {
  analysis: StructuredToolResult;
  composablePlan?: StructuredToolResult;
  discovery?: StructuredToolResult;
  highLevelPreparation: StructuredToolResult;
  scenarioId: string;
}): TargetDiscoveryScenarioEvidenceV1 {
  const discovery = input.discovery?.structuredContent as { ambiguities?: unknown[] } | undefined;
  const preparation = input.highLevelPreparation.structuredContent as { kind?: unknown; plan?: unknown; status?: unknown } | undefined;
  const hasAmbiguity = (discovery?.ambiguities?.length ?? 0) > 0;
  const composableCompleted = isPlan(input.composablePlan?.structuredContent);
  const highLevelCompleted = preparation?.status === 'plan_created' && isPlan(preparation.plan);
  const explicitStaticStages = hasKind(input.analysis.structuredContent, 'investigation-analysis-summary')
    && hasKind(input.discovery?.structuredContent, 'investigation-target-discovery');
  const validHighLevelContract = preparation?.kind === 'sql-investigation-preparation'
    && (preparation.status === 'plan_created' || preparation.status === 'selection_required');
  return {
    ambiguityHandling: hasAmbiguity ? 'explicit_before_planning' : 'not_present',
    composable: {
      boundaryClarity: explicitStaticStages ? 'explicit_static_stages' : 'contract_mismatch',
      callCount: 1 + (input.discovery ? 1 : 0) + (input.composablePlan ? 1 : 0),
      completed: composableCompleted,
      errorLocalization: input.analysis.isError
        ? 'analysis'
        : input.discovery?.isError
          ? 'target_discovery'
          : input.composablePlan?.isError ? 'plan_creation' : 'none',
      intermediateJsonBytes: jsonBytes(input.analysis.structuredContent) + jsonBytes(input.discovery?.structuredContent),
      selectionOutcome: input.analysis.isError || input.discovery?.isError || input.composablePlan?.isError
        ? 'failed'
        : composableCompleted ? 'plan_created' : 'selection_required',
    },
    highLevel: {
      boundaryClarity: validHighLevelContract ? 'high_level_static_contract' : 'contract_mismatch',
      callCount: 1,
      completed: highLevelCompleted,
      errorLocalization: input.highLevelPreparation.isError ? 'preparation' : 'none',
      intermediateJsonBytes: 0,
      selectionOutcome: input.highLevelPreparation.isError
        ? 'failed'
        : highLevelCompleted ? 'plan_created' : 'selection_required',
    },
    kind: 'target-discovery-workflow-evidence',
    realLlmToolSelection: 'UNCONFIRMED',
    scenarioId: input.scenarioId,
    version: 1,
  };
}

function isPlan(value: unknown): boolean {
  return hasKind(value, 'investigation-plan');
}

function hasKind(value: unknown, kind: string): boolean {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === kind);
}

function jsonBytes(value: unknown): number {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8');
}
