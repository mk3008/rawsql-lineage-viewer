export interface McpWorkflowEvidenceV1 {
  boundaryClarity: 'contract_mismatch' | 'explicit_static_stages' | 'not_attempted' | 'single_request_static_contract';
  callCount: number;
  completed: boolean;
  errorLocalization: 'not_attempted' | 'plan_creation' | 'target_discovery';
  intermediateJsonBytes: number;
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

type StructuredToolResult = { structuredContent?: unknown };

/**
 * Measures only static MCP response shapes. It does not execute SQL, ingest probe
 * results, or infer how a real LLM would choose tools.
 */
export function measureTargetDiscoveryWorkflows(input: {
  analysis: StructuredToolResult;
  discovery: StructuredToolResult;
  highLevelPlan?: StructuredToolResult;
  scenarioId: string;
  composablePlan?: StructuredToolResult;
}): TargetDiscoveryScenarioEvidenceV1 {
  const discovery = input.discovery.structuredContent as { ambiguities?: unknown[] } | undefined;
  const hasAmbiguity = (discovery?.ambiguities?.length ?? 0) > 0;
  const explicitStaticStages = hasKind(input.analysis.structuredContent, 'investigation-analysis-summary')
    && hasKind(input.discovery.structuredContent, 'investigation-target-discovery');
  return {
    ambiguityHandling: hasAmbiguity ? 'explicit_before_planning' : 'not_present',
    composable: {
      boundaryClarity: explicitStaticStages ? 'explicit_static_stages' : 'contract_mismatch',
      callCount: input.composablePlan ? 3 : 2,
      completed: isPlan(input.composablePlan?.structuredContent),
      errorLocalization: hasAmbiguity ? 'target_discovery' : 'plan_creation',
      intermediateJsonBytes: jsonBytes(input.analysis.structuredContent) + jsonBytes(input.discovery.structuredContent),
    },
    highLevel: {
      boundaryClarity: input.highLevelPlan
        ? isPlan(input.highLevelPlan.structuredContent) ? 'single_request_static_contract' : 'contract_mismatch'
        : 'not_attempted',
      callCount: input.highLevelPlan ? 1 : 0,
      completed: isPlan(input.highLevelPlan?.structuredContent),
      errorLocalization: input.highLevelPlan ? 'plan_creation' : 'not_attempted',
      intermediateJsonBytes: 0,
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
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}
