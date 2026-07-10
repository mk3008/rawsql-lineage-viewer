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
