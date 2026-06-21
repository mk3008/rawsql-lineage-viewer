import type { Edge, Node } from '@xyflow/react';
import type { LineageColumn, LineageEdge, LineageNode } from './lineage';
import type { CollapsedLineageGroup } from '../graph/collapseGroups';

export type GraphNodeData = {
  lineageNode: LineageNode;
  canToggleColumns?: boolean;
  columnsVisible?: boolean;
  forcedVisibleColumnIds?: Set<string>;
  collapsedGroup?: CollapsedLineageGroup;
  canCollapseUpstream?: boolean;
  onToggleColumns?: (nodeId: string) => void;
  onCollapseUpstream?: (nodeId: string) => void;
  onExpandGroup?: (nodeId: string) => void;
  onNodeSelect?: (nodeId: string) => void;
  selectedNodeId?: string | null;
  selectedColumnId?: string | null;
  selectedCommentTargetIds?: Set<string>;
  selectedRuleExpressionByColumnId?: Map<string, string>;
  activeCommentTargetId?: string | null;
  viewportZoom?: number;
  activeLineageRootColumnIds?: Set<string>;
  highlightedColumnIds?: Set<string>;
  highlightedNodeIds?: Set<string>;
  highlightedNodeImpactLabels?: Map<string, string[]>;
  highlightedNodeTone?: 'population' | 'value';
  highlightedSourceDataLabels?: Map<string, string[]>;
  highlightedSourceDataNodeIds?: Set<string>;
  passthroughColumnsCompressed?: boolean;
  showUnusedColumns?: boolean;
  sourceColumnIds?: Set<string>;
  onColumnSelect?: (nodeId: string, column: LineageColumn) => void;
  onTogglePassthroughColumns?: (nodeId: string) => void;
  onCommentClose?: (targetId: string) => void;
  onCommentFocus?: (targetId: string) => void;
};

export type GraphEdgeData = {
  lineageEdge: LineageEdge;
};

export type GraphNode = Node<GraphNodeData, 'lineageNode'>;
export type GraphEdge = Edge<GraphEdgeData>;

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
