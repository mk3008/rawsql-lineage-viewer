import type { EdgeVisibility, GraphEdge, GraphModel } from '../domain/graph';
import type { LineageEdge, LineageModel, LineageNode } from '../domain/lineage';

const nodeSize = {
  width: 220,
  height: 120,
};

export function buildGraphModel(lineage: LineageModel, edgeVisibility: EdgeVisibility): GraphModel {
  const positioned = layoutNodes(lineage.nodes, lineage.edges);
  const visibleEdges = lineage.edges.filter((edge) => {
    if (edge.type === 'dataFlow') {
      return edgeVisibility.dataFlow;
    }
    if (edge.type === 'join') {
      return edgeVisibility.join;
    }
    return true;
  });

  return {
    nodes: positioned.map((node) => ({
      id: node.id,
      type: 'lineageNode',
      position: node.position,
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

  for (const node of nodes) {
    const depth = depthByNode.get(node.id) ?? 0;
    groups.set(depth, [...(groups.get(depth) ?? []), node]);
  }

  return [...groups.entries()].flatMap(([depth, group]) =>
    group
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((node, index) => ({
        id: node.id,
        lineageNode: node,
        position: {
          x: depth * 300,
          y: index * 170 + Math.max(0, 2 - group.length) * 80,
        },
      })),
  );
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
  const isJoin = edge.type === 'join';
  const isOuterJoin = isJoin && edge.joinType !== 'inner';
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    animated: false,
    label: edge.label,
    data: {
      lineageEdge: edge,
    },
    style: {
      stroke: isJoin ? '#2563eb' : '#059669',
      strokeWidth: 2,
      strokeDasharray: isOuterJoin ? '8 5' : undefined,
    },
    markerEnd: {
      type: 'arrowclosed',
      color: isJoin ? '#2563eb' : '#059669',
    },
  };
}

export const graphNodeSize = nodeSize;
