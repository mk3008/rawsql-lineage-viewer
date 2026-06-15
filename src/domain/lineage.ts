export type LineageNodeType = 'table' | 'cte' | 'derived' | 'output';

export type LineageEdgeType = 'dataFlow' | 'join' | 'expression' | 'unknown';

export interface LineageColumnRef {
  nodeId: string;
  columnName: string;
}

export interface LineageColumn {
  id: string;
  name: string;
  comments?: string[];
  upstream?: LineageColumnRef[];
}

export interface LineageNode {
  id: string;
  type: LineageNodeType;
  label: string;
  columns: LineageColumn[];
  comments?: string[];
  materializationHint?: 'MATERIALIZED' | 'NOT MATERIALIZED' | 'none';
}

export interface LineageEdge {
  id: string;
  source: string;
  target: string;
  type: LineageEdgeType;
  label?: string;
  joinType?: 'inner' | 'left' | 'right' | 'full' | 'unknown';
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
    flowDirection: 'downstream';
  };
}
