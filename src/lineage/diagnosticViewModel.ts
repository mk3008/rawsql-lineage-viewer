import type {
  CandidateConcern,
  ColumnDiagnosticPacket,
  DiagnosticSourceReference,
  DiagnosticValueColumn,
  PopulationEffect,
  PopulationInfluence,
  PopulationMechanism,
  PopulationSignal,
  ColumnLineageTreeNode,
} from './diagnostics';

export interface DiagnosticTreeViewModel {
  candidateConcerns: DiagnosticConcernViewModel[];
  json: string;
  rowLineage: {
    influences: DiagnosticInfluenceViewModel[];
    nodeImpacts: DiagnosticNodeImpactViewModel[];
    summary: string;
  };
  target: {
    columnName: string;
    nodeLabel: string;
    nodeType: string;
  };
  columnLineage: {
    caseRules: DiagnosticCaseRuleViewModel[];
    expressions: DiagnosticExpressionViewModel[];
    sourceColumns: DiagnosticReferenceViewModel[];
    sourceLeaves: DiagnosticValueColumn[];
    summary: string;
    tree: ColumnLineageTreeNode[];
  };
}

export interface DiagnosticGraphViewModel {
  edges: Array<{
    effects: PopulationEffect[];
    kind: string;
    sourceIds: string[];
    targetId: string;
  }>;
  nodes: Array<{
    id: string;
    label: string;
    role: 'concern' | 'influence' | 'source' | 'target';
  }>;
}

export interface DiagnosticReferenceViewModel {
  columnName: string;
  nodeId: string;
  nodeLabel: string;
  roles: DiagnosticSourceReference['roles'];
  usages: string[];
}

export interface DiagnosticExpressionViewModel {
  columnName: string;
  expressionSql?: string;
  nodeId: string;
  scopeId: string;
}

export interface DiagnosticCaseRuleViewModel {
  conditionReferences: DiagnosticReferenceViewModel[];
  conditionSql?: string;
  id: string;
  label: string;
  resultReferences: DiagnosticReferenceViewModel[];
  resultSql?: string;
}

export interface DiagnosticInfluenceViewModel {
  effects: PopulationEffect[];
  expressionSql?: string;
  id: string;
  kind: string;
  mechanism: PopulationMechanism;
  references: DiagnosticReferenceViewModel[];
  scopeId: string;
  signals: PopulationSignal[];
}

export interface DiagnosticConcernViewModel {
  confidence: CandidateConcern['confidence'];
  evidence: string[];
  impact: string[];
  influenceIds: string[];
  kind: string;
  reason: string;
  scopeId: string;
  signals: PopulationSignal[];
}

export interface DiagnosticNodeImpactViewModel {
  effects: PopulationEffect[];
  influenceIds: string[];
  nodeId: string;
  nodeLabel: string;
  nodeType: string;
  role: 'population_and_value' | 'population_only';
  signals: PopulationSignal[];
}

export function buildDiagnosticTreeViewModel(packet: ColumnDiagnosticPacket): DiagnosticTreeViewModel {
  const referencesById = new Map(packet.columnLineage.references.map((reference) => [reference.id ?? `${reference.nodeId}.${reference.columnName}`, reference]));
  return {
    candidateConcerns: packet.candidateConcerns.map(toConcernViewModel),
    json: JSON.stringify(packet, null, 2),
    rowLineage: {
      influences: packet.rowLineage.influences.map(toInfluenceViewModel),
      nodeImpacts: packet.rowLineage.nodeImpacts.map((nodeImpact) => ({ ...nodeImpact })),
      summary: packet.rowLineage.summary,
    },
    target: {
      columnName: packet.target.columnName,
      nodeLabel: packet.target.nodeLabel,
      nodeType: packet.target.nodeType,
    },
    columnLineage: {
      caseRules: packet.columnLineage.caseRules.map((rule) => ({
        conditionReferences: rule.conditionRefIds.flatMap((id) => {
          const reference = referencesById.get(id);
          return reference ? [toReferenceViewModel(reference)] : [];
        }),
        conditionSql: rule.conditionSql,
        id: rule.id,
        label: rule.label,
        resultReferences: rule.resultRefIds.flatMap((id) => {
          const reference = referencesById.get(id);
          return reference ? [toReferenceViewModel(reference)] : [];
        }),
        resultSql: rule.resultSql,
      })),
      expressions: packet.columnLineage.expressionChain.map((expression) => ({ ...expression })),
      sourceColumns: packet.columnLineage.references.map(toReferenceViewModel),
      sourceLeaves: packet.columnLineage.sourceLeaves.map((source) => ({ ...source })),
      summary: formatColumnLineageSummary(packet.columnLineage.summary),
      tree: packet.views.columnLineageTree.tree,
    },
  };
}

export function buildDiagnosticGraphViewModel(packet: ColumnDiagnosticPacket): DiagnosticGraphViewModel {
  const targetId = `target:${packet.target.nodeId}.${packet.target.columnName}`;
  const nodes = new Map<string, DiagnosticGraphViewModel['nodes'][number]>();
  nodes.set(targetId, {
    id: targetId,
    label: `${packet.target.nodeLabel}.${packet.target.columnName}`,
    role: 'target',
  });

  const edges: DiagnosticGraphViewModel['edges'] = [];
  for (const reference of packet.columnLineage.references) {
    const sourceId = referenceId(reference);
    nodes.set(sourceId, {
      id: sourceId,
      label: `${reference.nodeLabel}.${reference.columnName}`,
      role: 'source',
    });
    edges.push({
      effects: [],
      kind: 'column_lineage',
      sourceIds: [sourceId],
      targetId,
    });
  }

  for (const influence of packet.rowLineage.influences) {
    const influenceId = `influence:${influence.id}`;
    nodes.set(influenceId, {
      id: influenceId,
      label: influence.kind,
      role: 'influence',
    });
    const sourceIds = influence.references.map((reference) => {
      const sourceId = referenceId(reference);
      nodes.set(sourceId, {
        id: sourceId,
        label: `${reference.nodeLabel}.${reference.columnName}`,
        role: 'source',
      });
      return sourceId;
    });
    edges.push({
      effects: influence.effects,
      kind: influence.kind,
      sourceIds,
      targetId: influenceId,
    });
    edges.push({
      effects: influence.effects,
      kind: 'row_lineage',
      sourceIds: [influenceId],
      targetId,
    });
  }

  return {
    edges,
    nodes: [...nodes.values()],
  };
}

function formatColumnLineageSummary(summary: ColumnDiagnosticPacket['columnLineage']['summary']): string {
  if (summary.sourceLeafCount === 0) {
    return 'No upstream column lineage source leaves were found for this target.';
  }
  return [
    `${summary.sourceLeafCount} source leaf column(s)`,
    `${summary.intermediateReferenceCount} intermediate reference(s)`,
    `${summary.expressionStepCount} expression step(s)`,
    `${summary.caseRuleCount} CASE rule(s)`,
  ].join(', ');
}

function toInfluenceViewModel(influence: PopulationInfluence): DiagnosticInfluenceViewModel {
  return {
    effects: [...influence.effects],
    expressionSql: influence.expressionSql,
    id: influence.id,
    kind: influence.kind,
    mechanism: influence.mechanism,
    references: influence.references.map(toReferenceViewModel),
    scopeId: influence.scopeId,
    signals: [...influence.signals],
  };
}

function toConcernViewModel(concern: CandidateConcern): DiagnosticConcernViewModel {
  return {
    confidence: concern.confidence,
    evidence: [...concern.evidence],
    impact: [...concern.impact],
    influenceIds: [...concern.influenceIds],
    kind: concern.kind,
    reason: concern.reason,
    scopeId: concern.scopeId,
    signals: [...concern.signals],
  };
}

function toReferenceViewModel(reference: DiagnosticSourceReference): DiagnosticReferenceViewModel {
  return {
    columnName: reference.columnName,
    nodeId: reference.nodeId,
    nodeLabel: reference.nodeLabel,
    roles: [...reference.roles],
    usages: reference.usages.map((usage) => `${usage.role}:${usage.usageKind}:${usage.scopeId}`),
  };
}

function referenceId(reference: DiagnosticSourceReference): string {
  return `source:${reference.nodeId}.${reference.columnName}`;
}
