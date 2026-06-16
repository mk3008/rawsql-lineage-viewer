export type LineageNodeType = 'table' | 'cte' | 'derived' | 'output';

export type LineageEdgeType = 'dataFlow' | 'expression' | 'unknown';

export interface LineageColumnRef {
  nodeId: string;
  columnName: string;
}

export type LineageColumnUsageReason = 'join' | 'where' | 'having' | 'groupBy' | 'orderBy' | 'subquery';

export interface LineageColumnUsage {
  role: 'condition' | 'unused';
  reasons?: LineageColumnUsageReason[];
}

export interface LineageColumn {
  id: string;
  name: string;
  comments?: string[];
  expressionSql?: string;
  upstream?: LineageColumnRef[];
  usage?: LineageColumnUsage;
}

export interface LineageNode {
  id: string;
  type: LineageNodeType;
  label: string;
  columns: LineageColumn[];
  comments?: string[];
  cteExecutableSql?: string;
  materializationHint?: 'MATERIALIZED' | 'NOT MATERIALIZED' | 'none';
}

export interface LineageEdge {
  id: string;
  source: string;
  target: string;
  type: LineageEdgeType;
  label?: string;
  sourceAlias?: string;
  joinNullability?: {
    reason: 'outerJoin';
    joinType: 'left' | 'right' | 'full';
  };
  confidence?: 'high' | 'medium' | 'low';
}

export interface AnalysisWarning {
  code: string;
  message: string;
}

export interface LineageModel {
  kind: 'sql-lineage-model';
  modelVersion: 1;
  nodes: LineageNode[];
  edges: LineageEdge[];
  analysisWarnings: AnalysisWarning[];
  raw: {
    adapter: 'rawsql-ts-ast';
  };
}

export interface WorkspaceModel {
  kind: 'sql-lineage-workspace';
  schemaVersion: 1;
  modelVersion: 1;
  parserVersion: string;
  name: string;
  sql: string;
  lineage: LineageModel;
  view: {
    flowDirection: 'downstream' | 'upstream';
  };
}
