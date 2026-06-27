import type { GraphEdge, GraphModel } from '../domain/graph';
import type { LineageEdge, LineageModel, LineageNode } from '../domain/lineage';

export type GraphFlowDirection = 'downstream' | 'upstream';

export interface BuildGraphModelOptions {
  layoutVisibleNodeIds?: Set<string>;
  showUnreachableCtes?: boolean;
  visibleNodeIds?: Set<string>;
}

const nodeSize = {
  width: 220,
  height: 120,
};

const layoutSpacing = {
  x: 280,
  y: 180,
};

export function buildGraphModel(
  lineage: LineageModel,
  flowDirection: GraphFlowDirection = 'downstream',
  layoutLineage: LineageModel = lineage,
  options: BuildGraphModelOptions = {},
): GraphModel {
  const visibleNodeIds = collectGraphVisibleNodeIds(lineage, options);
  const layoutVisibleNodeIds = collectGraphVisibleNodeIds(layoutLineage, {
    layoutVisibleNodeIds: options.layoutVisibleNodeIds,
    showUnreachableCtes: options.showUnreachableCtes,
    visibleNodeIds: options.layoutVisibleNodeIds ?? (layoutLineage === lineage ? options.visibleNodeIds : undefined),
  });
  const visibleNodes = lineage.nodes.filter((node) => visibleNodeIds.has(node.id));
  const layoutVisibleNodes = layoutLineage.nodes.filter((node) => layoutVisibleNodeIds.has(node.id));
  const visibleEdges = lineage.edges.filter((edge) => edge.type === 'dataFlow' && !isRecursiveDataFlow(edge) && visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target));
  const layoutVisibleEdges = layoutLineage.edges.filter(
    (edge) => edge.type === 'dataFlow' && !isRecursiveDataFlow(edge) && layoutVisibleNodeIds.has(edge.source) && layoutVisibleNodeIds.has(edge.target),
  );
  const layoutEdges = flowDirection === 'upstream' ? visibleEdges.map(reverseLineageEdge) : visibleEdges;
  const uncollapsedLayoutEdges = flowDirection === 'upstream' ? layoutVisibleEdges.map(reverseLineageEdge) : layoutVisibleEdges;
  const layoutPositions = new Map(layoutNodes(layoutVisibleNodes, uncollapsedLayoutEdges).map((node) => [node.id, node.position]));
  const fallbackPositions = new Map(layoutNodes(visibleNodes, layoutEdges).map((node) => [node.id, node.position]));

  return {
    nodes: visibleNodes.map((node) => ({
      id: node.id,
      type: 'lineageNode',
      position: layoutPositions.get(node.id) ?? fallbackPositions.get(node.id) ?? { x: 0, y: 0 },
      draggable: true,
      data: {
        lineageNode: node,
      },
    })),
    edges: visibleEdges.map((edge) => toGraphEdge(edge, flowDirection)),
  };
}

export function collectOutputReachableNodeIds(lineage: LineageModel): Set<string> {
  const outputNodeIds = lineage.nodes.filter((node) => node.type === 'output').map((node) => node.id);
  return collectUpstreamReachableNodeIds(lineage, outputNodeIds);
}

export function collectUnreachableCteNodeIds(lineage: LineageModel): Set<string> {
  const outputReachableNodeIds = collectOutputReachableNodeIds(lineage);
  return new Set(lineage.nodes.filter((node) => node.type === 'cte' && !outputReachableNodeIds.has(node.id)).map((node) => node.id));
}

function collectGraphVisibleNodeIds(lineage: LineageModel, options: BuildGraphModelOptions): Set<string> {
  if (options.visibleNodeIds) {
    const lineageNodeIds = new Set(lineage.nodes.map((node) => node.id));
    return new Set([...options.visibleNodeIds].filter((nodeId) => lineageNodeIds.has(nodeId)));
  }

  const outputReachableNodeIds = collectOutputReachableNodeIds(lineage);
  if (!options.showUnreachableCtes) {
    return outputReachableNodeIds;
  }

  const unreachableCteNodeIds = collectUnreachableCteNodeIds(lineage);
  if (unreachableCteNodeIds.size === 0) {
    return outputReachableNodeIds;
  }

  const visibleNodeIds = new Set(outputReachableNodeIds);
  for (const nodeId of collectUpstreamReachableNodeIds(lineage, [...unreachableCteNodeIds])) {
    visibleNodeIds.add(nodeId);
  }
  return visibleNodeIds;
}

function collectUpstreamReachableNodeIds(lineage: LineageModel, rootNodeIds: string[]): Set<string> {
  const reachable = new Set(rootNodeIds);
  const incomingByTarget = new Map<string, LineageEdge[]>();

  for (const edge of lineage.edges) {
    if (edge.type !== 'dataFlow' || isRecursiveDataFlow(edge)) {
      continue;
    }
    incomingByTarget.set(edge.target, [...(incomingByTarget.get(edge.target) ?? []), edge]);
  }

  const queue = [...rootNodeIds];
  while (queue.length > 0) {
    const targetId = queue.shift()!;
    for (const edge of incomingByTarget.get(targetId) ?? []) {
      if (!reachable.has(edge.source)) {
        reachable.add(edge.source);
        queue.push(edge.source);
      }
    }
  }

  return reachable;
}

function isRecursiveDataFlow(edge: LineageEdge): boolean {
  return Boolean(edge.recursive) || edge.source === edge.target;
}

function layoutNodes(nodes: LineageNode[], edges: LineageEdge[]): Array<{ id: string; lineageNode: LineageNode; position: { x: number; y: number } }> {
  const depthByNode = calculateDepths(nodes, edges);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const groups = new Map<number, LineageNode[]>();
  const orderByNode = new Map<string, number>();
  const yByNode = new Map<string, number>();
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
    groups.set(depth, sorted);
    sorted.forEach((node, index) => {
      orderByNode.set(node.id, index);
      yByNode.set(node.id, index * layoutSpacing.y);
    });
  }

  alignLayerYPositions(groups, edges, yByNode, nodeById);

  for (const [depth, group] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    group.forEach((node) => {
      positioned.push({
        id: node.id,
        lineageNode: node,
        position: {
          x: depth * layoutSpacing.x,
          y: yByNode.get(node.id) ?? 0,
        },
      });
    });
  }

  return positioned;
}

function alignLayerYPositions(
  groups: Map<number, LineageNode[]>,
  edges: LineageEdge[],
  yByNode: Map<string, number>,
  nodeById: Map<string, LineageNode>,
) {
  const depths = [...groups.keys()].sort((a, b) => a - b);
  const incomingByNode = groupNeighborIds(edges, 'target');
  const outgoingByNode = groupNeighborIds(edges, 'source');

  for (let iteration = 0; iteration < 4; iteration += 1) {
    for (const depth of depths) {
      alignLayerToNeighbors(groups, depth, incomingByNode, yByNode, nodeById);
    }
    for (const depth of [...depths].reverse()) {
      alignLayerToNeighbors(groups, depth, outgoingByNode, yByNode, nodeById);
    }
  }
}

function alignLayerToNeighbors(
  groups: Map<number, LineageNode[]>,
  depth: number,
  neighborsByNode: Map<string, string[]>,
  yByNode: Map<string, number>,
  nodeById: Map<string, LineageNode>,
) {
  const group = groups.get(depth);
  if (!group?.length) {
    return;
  }

  const desiredYByNode = new Map(
    group.map((node) => {
      const neighborYs = (neighborsByNode.get(node.id) ?? [])
        .map((neighborId) => {
          const y = yByNode.get(neighborId);
          const neighbor = nodeById.get(neighborId);
          return y === undefined ? null : { weight: neighbor ? layoutAlignmentWeight(neighbor) : 1, y };
        })
        .filter((item): item is { weight: number; y: number } => item !== null);
      const currentY = yByNode.get(node.id) ?? 0;
      return [node.id, neighborYs.length ? weightedAverage(neighborYs) : currentY] as const;
    }),
  );

  const sorted = [...group].sort((a, b) => {
    const desiredDelta = (desiredYByNode.get(a.id) ?? 0) - (desiredYByNode.get(b.id) ?? 0);
    if (desiredDelta !== 0) {
      return desiredDelta;
    }
    return (yByNode.get(a.id) ?? 0) - (yByNode.get(b.id) ?? 0) || nodeTypeRank(a) - nodeTypeRank(b) || a.label.localeCompare(b.label);
  });
  const packedY = packLayer(sorted, desiredYByNode);
  groups.set(depth, sorted);
  for (const node of sorted) {
    yByNode.set(node.id, packedY.get(node.id) ?? yByNode.get(node.id) ?? 0);
  }
}

function packLayer(nodes: LineageNode[], desiredYByNode: Map<string, number>): Map<string, number> {
  const packed = new Map<string, number>();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const previous = nodes[index - 1];
    const previousY = previous ? packed.get(previous.id) : undefined;
    packed.set(node.id, Math.max(desiredYByNode.get(node.id) ?? 0, previousY === undefined ? Number.NEGATIVE_INFINITY : previousY + layoutSpacing.y));
  }
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    const next = nodes[index + 1];
    const nextY = next ? packed.get(next.id) : undefined;
    packed.set(node.id, Math.min(packed.get(node.id) ?? 0, nextY === undefined ? desiredYByNode.get(node.id) ?? 0 : nextY - layoutSpacing.y));
  }
  const minY = Math.min(...nodes.map((node) => packed.get(node.id) ?? 0));
  if (minY < 0) {
    for (const node of nodes) {
      packed.set(node.id, (packed.get(node.id) ?? 0) - minY);
    }
  }
  return packed;
}

function groupNeighborIds(edges: LineageEdge[], nodeSide: 'source' | 'target'): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    const nodeId = edge[nodeSide];
    const neighborId = nodeSide === 'source' ? edge.target : edge.source;
    result.set(nodeId, [...(result.get(nodeId) ?? []), neighborId]);
  }
  return result;
}

function layoutAlignmentWeight(node: LineageNode): number {
  if (node.type === 'output') return 6;
  if (node.type === 'cte') return 4;
  if (node.type === 'scalar_subquery') return 3.5;
  if (node.type === 'derived') return 3;
  if (node.type === 'parameter_table') return 1.5;
  return 1;
}

function weightedAverage(values: Array<{ weight: number; y: number }>): number {
  const weightSum = values.reduce((sum, value) => sum + value.weight, 0);
  return values.reduce((sum, value) => sum + value.y * value.weight, 0) / weightSum;
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
  if (node.type === 'parameter_table') return 0;
  if (node.type === 'cte') return 1;
  if (node.type === 'derived') return 2;
  if (node.type === 'scalar_subquery') return 3;
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

function reverseLineageEdge(edge: LineageEdge): LineageEdge {
  return {
    ...edge,
    source: edge.target,
    target: edge.source,
  };
}

function toGraphEdge(edge: LineageEdge, flowDirection: GraphFlowDirection): GraphEdge {
  const lineStyle = getLineageEdgeLineStyle(edge);
  const source = flowDirection === 'upstream' ? edge.target : edge.source;
  const target = flowDirection === 'upstream' ? edge.source : edge.target;
  return {
    id: edge.id,
    source,
    target,
    type: 'lineageDataFlow',
    label: edge.sourceAlias,
    labelBgPadding: edge.sourceAlias ? [6, 3] : undefined,
    labelBgBorderRadius: edge.sourceAlias ? 6 : undefined,
    animated: false,
    data: {
      lineageEdge: edge,
    },
    style: {
      stroke: lineStyle.stroke,
      strokeWidth: 1.5,
      strokeDasharray: lineStyle.strokeDasharray,
    },
  };
}

function getLineageEdgeLineStyle(edge: LineageEdge): { stroke: string; strokeDasharray?: string } {
  if (edge.kind === 'predicate_subquery') {
    return {
      stroke: '#d97706',
      strokeDasharray: '6 5',
    };
  }
  if (edge.joinNullability?.reason === 'outerJoin') {
    return {
      stroke: '#059669',
      strokeDasharray: '8 5',
    };
  }
  return {
    stroke: '#059669',
  };
}

export const graphNodeSize = nodeSize;
