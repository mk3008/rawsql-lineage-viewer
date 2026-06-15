import type { GraphEdge, GraphModel } from '../domain/graph';
import type { LineageEdge, LineageModel, LineageNode } from '../domain/lineage';

const nodeSize = {
  width: 220,
  height: 120,
};

const layoutSpacing = {
  x: 360,
  y: 300,
};

export function buildGraphModel(lineage: LineageModel): GraphModel {
  const visibleEdges = lineage.edges.filter((edge) => edge.type === 'dataFlow');
  const positioned = layoutNodes(lineage.nodes, visibleEdges);

  return {
    nodes: positioned.map((node) => ({
      id: node.id,
      type: 'lineageNode',
      position: node.position,
      draggable: true,
      data: {
        lineageNode: node.lineageNode,
      },
    })),
    edges: visibleEdges.map(toGraphEdge),
  };
}

function layoutNodes(nodes: LineageNode[], edges: LineageEdge[]): Array<{ id: string; lineageNode: LineageNode; position: { x: number; y: number } }> {
  const depthByNode = calculateDepths(nodes, edges);
  const groups = new Map<number, LineageNode[]>();
  const orderByNode = new Map<string, number>();
  const positioned: Array<{ id: string; lineageNode: LineageNode; position: { x: number; y: number } }> = [];

  for (const node of nodes) {
    const depth = depthByNode.get(node.id) ?? 0;
    groups.set(depth, [...(groups.get(depth) ?? []), node]);
  }

  for (const [depth, group] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    const sorted = [...group].sort((a, b) => {
      const upstreamDelta = upstreamOrder(a.id, edges, orderByNode) - upstreamOrder(b.id, edges, orderByNode);
      if (upstreamDelta !== 0) {
        return upstreamDelta;
      }
      return nodeTypeRank(a) - nodeTypeRank(b) || a.label.localeCompare(b.label);
    });
    const offset = Math.max(0, 2 - sorted.length) * 90 + (depth % 2) * 34;

    sorted.forEach((node, index) => {
      orderByNode.set(node.id, index);
      positioned.push({
        id: node.id,
        lineageNode: node,
        position: {
          x: depth * layoutSpacing.x,
          y: index * layoutSpacing.y + offset,
        },
      });
    });
  }

  return positioned;
}

function upstreamOrder(nodeId: string, edges: LineageEdge[], orderByNode: Map<string, number>): number {
  const upstream = edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => orderByNode.get(edge.source))
    .filter((order): order is number => order !== undefined);
  if (upstream.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return upstream.reduce((sum, order) => sum + order, 0) / upstream.length;
}

function nodeTypeRank(node: LineageNode): number {
  if (node.type === 'table') return 0;
  if (node.type === 'cte') return 1;
  if (node.type === 'derived') return 2;
  return 3;
}

function calculateDepths(nodes: LineageNode[], edges: LineageEdge[]): Map<string, number> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const depthByNode = new Map(nodes.map((node) => [node.id, 0]));
  const usableEdges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  for (let i = 0; i < nodes.length; i += 1) {
    let changed = false;
    for (const edge of usableEdges) {
      const nextDepth = (depthByNode.get(edge.source) ?? 0) + 1;
      if (nextDepth > (depthByNode.get(edge.target) ?? 0)) {
        depthByNode.set(edge.target, nextDepth);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  return depthByNode;
}

function toGraphEdge(edge: LineageEdge): GraphEdge {
  const isNullableByOuterJoin = edge.joinNullability?.reason === 'outerJoin';
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'lineageDataFlow',
    label: edge.sourceAlias,
    labelBgPadding: edge.sourceAlias ? [6, 3] : undefined,
    labelBgBorderRadius: edge.sourceAlias ? 6 : undefined,
    animated: false,
    data: {
      lineageEdge: edge,
    },
    style: {
      stroke: '#059669',
      strokeWidth: 2,
      strokeDasharray: isNullableByOuterJoin ? '8 5' : undefined,
    },
    markerEnd: {
      type: 'arrowclosed',
      color: '#059669',
    },
  };
}

export const graphNodeSize = nodeSize;
