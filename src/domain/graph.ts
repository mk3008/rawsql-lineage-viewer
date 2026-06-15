import type { Edge, Node } from '@xyflow/react';
import type { LineageEdge, LineageNode } from './lineage';

export type GraphNodeData = {
  lineageNode: LineageNode;
  columnsVisible?: boolean;
  onToggleColumns?: (nodeId: string) => void;
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
