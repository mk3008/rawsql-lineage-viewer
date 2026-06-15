import type { Edge, Node } from '@xyflow/react';
import type { LineageColumn, LineageEdge, LineageNode } from './lineage';

export type GraphNodeData = {
  lineageNode: LineageNode;
  columnsVisible?: boolean;
  onToggleColumns?: (nodeId: string) => void;
  onNodeSelect?: (nodeId: string) => void;
  selectedColumnId?: string | null;
  selectedCommentTargetIds?: Set<string>;
  activeCommentTargetId?: string | null;
  viewportZoom?: number;
  highlightedColumnIds?: Set<string>;
  sourceColumnIds?: Set<string>;
  onColumnSelect?: (nodeId: string, column: LineageColumn) => void;
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
