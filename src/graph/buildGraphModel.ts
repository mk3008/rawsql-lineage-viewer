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

const edgeCorridorPadding = 18;
const edgeCorridorPenalty = 100_000;

interface Point {
  x: number;
  y: number;
}

interface Rect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

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
  improveEdgeCorridorClearance(groups, edges, depthByNode, yByNode, nodeById);
  prioritizeContinuingNodesInLayer(groups, edges, yByNode);
  alignPrimaryOutputConsumers(groups, edges, depthByNode, yByNode, nodeById);
  alignScalarRowSourceChains(groups, edges, depthByNode, yByNode, nodeById);
  alignPrimaryTransformationSources(groups, edges, depthByNode, yByNode, nodeById);
  alignScalarRowSourceChains(groups, edges, depthByNode, yByNode, nodeById);
  alignPrimaryTransformationSources(groups, edges, depthByNode, yByNode, nodeById);
  pushSecondaryTransformationSourcesOutward(groups, edges, depthByNode, yByNode, nodeById);
  alignPrimaryTransformationSources(groups, edges, depthByNode, yByNode, nodeById);
  reduceForwardLayerCrossings(groups, edges, depthByNode, yByNode);
  alignPrimaryTransformationSources(groups, edges, depthByNode, yByNode, nodeById, false);
  pushPredicateTargetsOutward(edges, depthByNode, yByNode);
  compactUnusedVerticalLanes(yByNode);

  const minY = Math.min(...nodes.map((node) => yByNode.get(node.id) ?? 0));
  const yOffset = minY < 0 ? -minY : 0;

  for (const [depth, group] of [...groups.entries()].sort(([a], [b]) => a - b)) {
    group.forEach((node) => {
      positioned.push({
        id: node.id,
        lineageNode: node,
        position: {
          x: depth * layoutSpacing.x,
          y: (yByNode.get(node.id) ?? 0) + yOffset,
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
    return nodeTypeRank(a) - nodeTypeRank(b) || (yByNode.get(a.id) ?? 0) - (yByNode.get(b.id) ?? 0) || a.label.localeCompare(b.label);
  });
  const packedY = packLayer(sorted, desiredYByNode);
  groups.set(depth, sorted);
  for (const node of sorted) {
    yByNode.set(node.id, packedY.get(node.id) ?? yByNode.get(node.id) ?? 0);
  }
}

function improveEdgeCorridorClearance(
  groups: Map<number, LineageNode[]>,
  edges: LineageEdge[],
  depthByNode: Map<string, number>,
  yByNode: Map<string, number>,
  nodeById: Map<string, LineageNode>,
) {
  const depths = [...groups.keys()].sort((a, b) => a - b);
  const incomingCountByNode = countEdgesByNode(edges, 'target');
  const outgoingCountByNode = countEdgesByNode(edges, 'source');

  for (const depth of depths) {
    const group = groups.get(depth);
    if (!group?.length) {
      continue;
    }

    const desiredYByNode = new Map(group.map((node) => [node.id, yByNode.get(node.id) ?? 0] as const));
    const continuityAnchorYByNode = new Map(
      group.map((node) => [node.id, continuityAnchorY(node, edges, yByNode, depthByNode, nodeById)] as const).filter((item): item is readonly [string, number] => item[1] !== null),
    );
    const layerCenterY = weightedAverage(
      group.map((node) => ({
        y: desiredYByNode.get(node.id) ?? 0,
        weight: 1 + layoutContinuityWeight(node.id, incomingCountByNode, outgoingCountByNode),
      })),
    );
    const sorted = [...group].sort((a, b) => {
      const priorityDelta =
        layoutPlacementPriority(b, incomingCountByNode, outgoingCountByNode) -
        layoutPlacementPriority(a, incomingCountByNode, outgoingCountByNode);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      const centerDistanceDelta = Math.abs((desiredYByNode.get(a.id) ?? 0) - layerCenterY) - Math.abs((desiredYByNode.get(b.id) ?? 0) - layerCenterY);
      if (centerDistanceDelta !== 0) {
        return centerDistanceDelta;
      }
      const desiredDelta = (desiredYByNode.get(a.id) ?? 0) - (desiredYByNode.get(b.id) ?? 0);
      if (desiredDelta !== 0) {
        return desiredDelta;
      }
      return nodeTypeRank(a) - nodeTypeRank(b) || a.label.localeCompare(b.label);
    });
    const packedY = packLayer(sorted, desiredYByNode, (node, candidateY) =>
      scoreEdgeCorridorIntersections(node.id, depth, candidateY, edges, depthByNode, yByNode) +
      scoreCentralLaneDistance(node.id, candidateY, layerCenterY, continuityAnchorYByNode, incomingCountByNode, outgoingCountByNode),
    );
    groups.set(depth, sorted);
    for (const node of sorted) {
      yByNode.set(node.id, packedY.get(node.id) ?? yByNode.get(node.id) ?? 0);
    }
  }
}

function continuityAnchorY(
  node: LineageNode,
  edges: LineageEdge[],
  yByNode: Map<string, number>,
  depthByNode: Map<string, number>,
  nodeById: Map<string, LineageNode>,
): number | null {
  const values: Array<{ weight: number; y: number }> = [];
  const outputConsumerValues: Array<{ weight: number; y: number }> = [];
  const nodeDepth = depthByNode.get(node.id);
  for (const edge of edges) {
    const isQueryBlock = node.type === 'cte' || node.type === 'derived';
    const neighborId = isQueryBlock
      ? edge.target === node.id ? edge.source : null
      : edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null;
    if (!neighborId) {
      continue;
    }
    const neighborY = yByNode.get(neighborId);
    const neighborDepth = depthByNode.get(neighborId);
    if (neighborY === undefined || neighborDepth === undefined) {
      continue;
    }
    const neighbor = nodeById.get(neighborId);
    const neighborWeight = neighbor ? layoutAlignmentWeight(neighbor) : 1;
    const isConsumerSide = nodeDepth === undefined || neighborDepth < nodeDepth;
    const value = { weight: neighborWeight * (isConsumerSide ? 2 : 1), y: neighborY };
    values.push(value);
    if (isQueryBlock && neighbor?.type === 'output') {
      outputConsumerValues.push(value);
    }
  }
  if (outputConsumerValues.length > 0) {
    return weightedAverage(outputConsumerValues);
  }
  return values.length > 0 ? weightedAverage(values) : null;
}

function countEdgesByNode(edges: LineageEdge[], side: 'source' | 'target'): Map<string, number> {
  const result = new Map<string, number>();
  for (const edge of edges) {
    result.set(edge[side], (result.get(edge[side]) ?? 0) + 1);
  }
  return result;
}

function layoutContinuityWeight(nodeId: string, incomingCountByNode: Map<string, number>, outgoingCountByNode: Map<string, number>): number {
  const incomingCount = incomingCountByNode.get(nodeId) ?? 0;
  const outgoingCount = outgoingCountByNode.get(nodeId) ?? 0;
  if (outgoingCount === 0) {
    return 0;
  }
  return 1 + Math.min(incomingCount, outgoingCount) + outgoingCount * 0.35;
}

function layoutPlacementPriority(node: LineageNode, incomingCountByNode: Map<string, number>, outgoingCountByNode: Map<string, number>): number {
  return layoutContinuityWeight(node.id, incomingCountByNode, outgoingCountByNode) * 10 + layoutAlignmentWeight(node);
}

function scoreCentralLaneDistance(
  nodeId: string,
  candidateY: number,
  layerCenterY: number,
  continuityAnchorYByNode: Map<string, number>,
  incomingCountByNode: Map<string, number>,
  outgoingCountByNode: Map<string, number>,
): number {
  const continuityWeight = layoutContinuityWeight(nodeId, incomingCountByNode, outgoingCountByNode);
  if (continuityWeight === 0) {
    return 0;
  }
  const anchorY = continuityAnchorYByNode.get(nodeId) ?? layerCenterY;
  return Math.abs(candidateY - anchorY) * (3 + continuityWeight);
}

function prioritizeContinuingNodesInLayer(groups: Map<number, LineageNode[]>, edges: LineageEdge[], yByNode: Map<string, number>) {
  const incomingCountByNode = countEdgesByNode(edges, 'target');
  const outgoingCountByNode = countEdgesByNode(edges, 'source');

  for (const group of groups.values()) {
    if (group.length < 3) {
      continue;
    }

    const continuingNodes = group.filter((node) => layoutContinuityWeight(node.id, incomingCountByNode, outgoingCountByNode) > 0);
    const leafNodes = group.filter((node) => (outgoingCountByNode.get(node.id) ?? 0) === 0);
    if (continuingNodes.length === 0 || leafNodes.length === 0) {
      continue;
    }

    const slots = group.map((node) => yByNode.get(node.id) ?? 0).sort((a, b) => a - b);
    const medianY = slots[Math.floor(slots.length / 2)];
    const centerFirstSlots = [...slots].sort((a, b) => Math.abs(a - medianY) - Math.abs(b - medianY) || a - b);
    const centralAssignments = new Map<string, number>();
    const continuingByPriority = [...continuingNodes].sort(
      (a, b) =>
        layoutPlacementPriority(b, incomingCountByNode, outgoingCountByNode) -
        layoutPlacementPriority(a, incomingCountByNode, outgoingCountByNode) ||
        Math.abs((yByNode.get(a.id) ?? 0) - medianY) - Math.abs((yByNode.get(b.id) ?? 0) - medianY),
    );

    for (const node of continuingByPriority) {
      const slot = centerFirstSlots.shift();
      if (slot === undefined) {
        break;
      }
      centralAssignments.set(node.id, slot);
    }

    const remainingSlots = centerFirstSlots.sort((a, b) => a - b);
    const remainingNodes = group
      .filter((node) => !centralAssignments.has(node.id))
      .sort((a, b) => (yByNode.get(a.id) ?? 0) - (yByNode.get(b.id) ?? 0) || nodeTypeRank(a) - nodeTypeRank(b) || a.label.localeCompare(b.label));

    for (const [index, node] of remainingNodes.entries()) {
      const slot = remainingSlots[index];
      if (slot !== undefined) {
        yByNode.set(node.id, slot);
      }
    }
    for (const [nodeId, slot] of centralAssignments.entries()) {
      yByNode.set(nodeId, slot);
    }
  }
}

function reduceForwardLayerCrossings(
  groups: Map<number, LineageNode[]>,
  edges: LineageEdge[],
  depthByNode: Map<string, number>,
  yByNode: Map<string, number>,
) {
  const depths = [...groups.keys()].sort((a, b) => a - b);
  for (const depth of depths) {
    const group = groups.get(depth);
    if (!group || group.length < 2) {
      continue;
    }

    const desiredYByNode = new Map(
      group.map((node) => {
        const incomingNeighborYs = edges
          .filter((edge) => edge.target === node.id && (depthByNode.get(edge.source) ?? depth) < depth)
          .map((edge) => {
            const y = yByNode.get(edge.source);
            return y === undefined ? null : { weight: layerCrossingEdgeWeight(edge), y };
          })
          .filter((item): item is { weight: number; y: number } => item !== null);
        return [node.id, incomingNeighborYs.length > 0 ? weightedAverage(incomingNeighborYs) : yByNode.get(node.id) ?? 0] as const;
      }),
    );
    const currentSlots = group.map((node) => yByNode.get(node.id) ?? 0).sort((a, b) => a - b);
    const sorted = [...group].sort((a, b) => {
      const desiredDelta = (desiredYByNode.get(a.id) ?? 0) - (desiredYByNode.get(b.id) ?? 0);
      if (desiredDelta !== 0) {
        return desiredDelta;
      }
      return (yByNode.get(a.id) ?? 0) - (yByNode.get(b.id) ?? 0) || nodeTypeRank(a) - nodeTypeRank(b) || a.label.localeCompare(b.label);
    });

    groups.set(depth, sorted);
    sorted.forEach((node, index) => {
      const slot = currentSlots[index];
      if (slot !== undefined) {
        yByNode.set(node.id, slot);
      }
    });
  }
}

function layerCrossingEdgeWeight(edge: LineageEdge): number {
  if (isLowPriorityLayoutEdge(edge)) {
    return 0.2;
  }
  if (edge.kind === 'subquery_value') {
    return 0.5;
  }
  return 1;
}

function alignPrimaryOutputConsumers(
  groups: Map<number, LineageNode[]>,
  edges: LineageEdge[],
  depthByNode: Map<string, number>,
  yByNode: Map<string, number>,
  nodeById: Map<string, LineageNode>,
) {
  const outgoingCountByNode = countEdgesByNode(edges, 'source');
  for (const edge of edges) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (sourceNode?.type !== 'output' || !targetNode || (targetNode.type !== 'cte' && targetNode.type !== 'derived')) {
      continue;
    }
    if ((outgoingCountByNode.get(targetNode.id) ?? 0) === 0) {
      continue;
    }

    const sourceY = yByNode.get(sourceNode.id);
    const targetY = yByNode.get(targetNode.id);
    const targetDepth = depthByNode.get(targetNode.id);
    if (sourceY === undefined || targetY === undefined || targetDepth === undefined || sourceY === targetY) {
      continue;
    }

    const group = groups.get(targetDepth) ?? [];
    const occupyingNode = group.find((node) => node.id !== targetNode.id && yByNode.get(node.id) === sourceY);
    yByNode.set(targetNode.id, sourceY);
    if (occupyingNode) {
      yByNode.set(occupyingNode.id, targetY);
    }
  }
}

function alignScalarRowSourceChains(
  groups: Map<number, LineageNode[]>,
  edges: LineageEdge[],
  depthByNode: Map<string, number>,
  yByNode: Map<string, number>,
  nodeById: Map<string, LineageNode>,
) {
  for (const edge of edges) {
    const sourceNode = nodeById.get(edge.source);
    if (sourceNode?.type !== 'scalar_subquery' || edge.kind !== 'row_source') {
      continue;
    }

    const sourceY = yByNode.get(edge.source);
    if (sourceY === undefined) {
      continue;
    }

    alignNodeToYWithinDepth(edge.target, sourceY, groups, depthByNode, yByNode);
  }
}

function alignPrimaryTransformationSources(
  groups: Map<number, LineageNode[]>,
  edges: LineageEdge[],
  depthByNode: Map<string, number>,
  yByNode: Map<string, number>,
  nodeById: Map<string, LineageNode>,
  allowDisplacement = true,
) {
  const scalarRowSourceTargets = new Set(
    edges
      .filter((edge) => nodeById.get(edge.source)?.type === 'scalar_subquery' && edge.kind === 'row_source')
      .map((edge) => edge.target),
  );

  for (const group of groups.values()) {
    for (const sourceNode of group) {
      if (sourceNode.type !== 'cte' && sourceNode.type !== 'derived') {
        continue;
      }

      const sourceY = yByNode.get(sourceNode.id);
      const sourceDepth = depthByNode.get(sourceNode.id);
      if (sourceY === undefined || sourceDepth === undefined) {
        continue;
      }

      const primarySourceEdge = collectTransformationSourceEdges(sourceNode, edges, depthByNode, nodeById, scalarRowSourceTargets)[0]?.edge;
      if (!primarySourceEdge) {
        continue;
      }

      alignNodeToYWithinDepth(primarySourceEdge.target, sourceY, groups, depthByNode, yByNode, scalarRowSourceTargets, allowDisplacement);
    }
  }
}

function pushSecondaryTransformationSourcesOutward(
  groups: Map<number, LineageNode[]>,
  edges: LineageEdge[],
  depthByNode: Map<string, number>,
  yByNode: Map<string, number>,
  nodeById: Map<string, LineageNode>,
) {
  const scalarRowSourceTargets = new Set(
    edges
      .filter((edge) => nodeById.get(edge.source)?.type === 'scalar_subquery' && edge.kind === 'row_source')
      .map((edge) => edge.target),
  );

  for (const group of groups.values()) {
    for (const sourceNode of group) {
      if (sourceNode.type !== 'cte' && sourceNode.type !== 'derived') {
        continue;
      }

      const sourceY = yByNode.get(sourceNode.id);
      if (sourceY === undefined) {
        continue;
      }

      const sourceEdges = collectTransformationSourceEdges(sourceNode, edges, depthByNode, nodeById, scalarRowSourceTargets);
      if (sourceEdges.length < 2) {
        continue;
      }

      const direction = transformationOuterDirection(sourceNode.id, sourceY, edges, yByNode, depthByNode);
      for (const { edge } of sourceEdges.slice(1)) {
        const targetY = yByNode.get(edge.target);
        const targetDepth = depthByNode.get(edge.target);
        if (targetY === undefined || targetDepth === undefined) {
          continue;
        }
        if ((targetY - sourceY) * direction > 0) {
          continue;
        }

        const groupAtDepth = groups.get(targetDepth) ?? [];
        const desiredY = chooseOutwardY(groupAtDepth, yByNode, edge.target, sourceY, direction);
        alignNodeToYWithinDepth(edge.target, desiredY, groups, depthByNode, yByNode, scalarRowSourceTargets);
      }
    }
  }
}

function collectTransformationSourceEdges(
  sourceNode: LineageNode,
  edges: LineageEdge[],
  depthByNode: Map<string, number>,
  nodeById: Map<string, LineageNode>,
  scalarRowSourceTargets: Set<string>,
): Array<{ edge: LineageEdge; index: number }> {
  const sourceDepth = depthByNode.get(sourceNode.id);
  if (sourceDepth === undefined) {
    return [];
  }

  return edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => {
      const targetNode = nodeById.get(edge.target);
      return (
        edge.source === sourceNode.id &&
        !isLowPriorityLayoutEdge(edge) &&
        edge.kind !== 'row_source' &&
        edge.kind !== 'subquery_value' &&
        targetNode?.type !== 'scalar_subquery' &&
        !scalarRowSourceTargets.has(edge.target) &&
        (depthByNode.get(edge.target) ?? sourceDepth) > sourceDepth
      );
    })
    .sort(
      (a, b) =>
        primarySourceTargetRank(nodeById.get(a.edge.target)) - primarySourceTargetRank(nodeById.get(b.edge.target)) ||
        a.index - b.index,
    );
}

function transformationOuterDirection(
  sourceNodeId: string,
  sourceY: number,
  edges: LineageEdge[],
  yByNode: Map<string, number>,
  depthByNode: Map<string, number>,
): -1 | 1 {
  const sourceDepth = depthByNode.get(sourceNodeId);
  const consumerYs = edges
    .filter((edge) => edge.target === sourceNodeId && (sourceDepth === undefined || (depthByNode.get(edge.source) ?? sourceDepth) < sourceDepth))
    .map((edge) => yByNode.get(edge.source))
    .filter((y): y is number => y !== undefined);
  const anchorY = consumerYs.length > 0 ? weightedAverage(consumerYs.map((y) => ({ y, weight: 1 }))) : sourceY;
  return sourceY < anchorY ? -1 : 1;
}

function chooseOutwardY(group: LineageNode[], yByNode: Map<string, number>, movingNodeId: string, sourceY: number, direction: -1 | 1): number {
  const occupiedSlots = new Set(
    group
      .filter((node) => node.id !== movingNodeId)
      .map((node) => Math.round((yByNode.get(node.id) ?? 0) / layoutSpacing.y)),
  );
  const sourceSlot = Math.round(sourceY / layoutSpacing.y);
  const maxRadius = group.length + 8;

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    const candidateSlot = sourceSlot + direction * radius;
    if (!occupiedSlots.has(candidateSlot)) {
      return candidateSlot * layoutSpacing.y;
    }
  }

  return sourceY + direction * layoutSpacing.y;
}

function primarySourceTargetRank(node: LineageNode | undefined): number {
  if (!node) return 3;
  if (node.type === 'table' || node.type === 'parameter_table') return 0;
  if (node.type === 'cte' || node.type === 'derived') return 1;
  return 2;
}

function alignNodeToYWithinDepth(
  nodeId: string,
  desiredY: number,
  groups: Map<number, LineageNode[]>,
  depthByNode: Map<string, number>,
  yByNode: Map<string, number>,
  protectedNodeIds: Set<string> = new Set(),
  allowDisplacement = true,
) {
  const currentY = yByNode.get(nodeId);
  const depth = depthByNode.get(nodeId);
  if (currentY === undefined || depth === undefined || currentY === desiredY) {
    return;
  }

  const group = groups.get(depth) ?? [];
  const occupyingNode = group.find((node) => node.id !== nodeId && yByNode.get(node.id) === desiredY);
  if (occupyingNode && protectedNodeIds.has(occupyingNode.id)) {
    return;
  }
  if (occupyingNode && !allowDisplacement) {
    return;
  }
  yByNode.set(nodeId, desiredY);
  if (occupyingNode) {
    yByNode.set(occupyingNode.id, chooseDisplacedY(group, yByNode, nodeId, occupyingNode.id, desiredY, currentY));
  }
}

function chooseDisplacedY(
  group: LineageNode[],
  yByNode: Map<string, number>,
  movingNodeId: string,
  displacedNodeId: string,
  desiredY: number,
  previousMovingY: number,
): number {
  const occupiedSlots = new Set(
    group
      .filter((node) => node.id !== movingNodeId && node.id !== displacedNodeId)
      .map((node) => Math.round((yByNode.get(node.id) ?? 0) / layoutSpacing.y)),
  );
  const desiredSlot = Math.round(desiredY / layoutSpacing.y);
  const direction = previousMovingY < desiredY ? 1 : -1;
  const maxRadius = group.length + 8;

  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (const candidateSlot of [desiredSlot + direction * radius, desiredSlot - direction * radius]) {
      if (!occupiedSlots.has(candidateSlot)) {
        return candidateSlot * layoutSpacing.y;
      }
    }
  }

  return previousMovingY;
}

function pushPredicateTargetsOutward(edges: LineageEdge[], depthByNode: Map<string, number>, yByNode: Map<string, number>) {
  for (const predicateEdge of edges) {
    if (!isLowPriorityLayoutEdge(predicateEdge)) {
      continue;
    }

    const sourceY = yByNode.get(predicateEdge.source);
    const targetY = yByNode.get(predicateEdge.target);
    const targetDepth = depthByNode.get(predicateEdge.target);
    if (sourceY === undefined || targetY === undefined || targetDepth === undefined) {
      continue;
    }

    const primarySibling = edges
      .filter((edge) =>
        edge.source === predicateEdge.source &&
        edge.target !== predicateEdge.target &&
        !isLowPriorityLayoutEdge(edge) &&
        depthByNode.get(edge.target) === targetDepth &&
        yByNode.has(edge.target),
      )
      .sort((a, b) => Math.abs((yByNode.get(b.target) ?? sourceY) - sourceY) - Math.abs((yByNode.get(a.target) ?? sourceY) - sourceY))[0];
    if (!primarySibling) {
      continue;
    }

    const primaryY = yByNode.get(primarySibling.target);
    if (primaryY === undefined || Math.abs(targetY - sourceY) >= Math.abs(primaryY - sourceY)) {
      continue;
    }

    yByNode.set(predicateEdge.target, primaryY);
    yByNode.set(primarySibling.target, targetY);
  }
}

function isLowPriorityLayoutEdge(edge: LineageEdge): boolean {
  return edge.kind === 'correlation' || edge.kind === 'predicate_subquery';
}

function compactUnusedVerticalLanes(yByNode: Map<string, number>) {
  const usedYValues = [...new Set(yByNode.values())].sort((a, b) => a - b);
  const compactedYByOriginalY = new Map(usedYValues.map((y, index) => [y, index * layoutSpacing.y] as const));
  for (const [nodeId, y] of yByNode.entries()) {
    yByNode.set(nodeId, compactedYByOriginalY.get(y) ?? y);
  }
}

function packLayer(
  nodes: LineageNode[],
  desiredYByNode: Map<string, number>,
  scoreCandidate: (node: LineageNode, candidateY: number) => number = () => 0,
): Map<string, number> {
  const packed = new Map<string, number>();
  const occupiedSlots = new Set<number>();

  for (const node of nodes) {
    const preferredSlot = Math.round((desiredYByNode.get(node.id) ?? 0) / layoutSpacing.y);
    const slot = chooseLayerSlot(node, preferredSlot, occupiedSlots, scoreCandidate);
    occupiedSlots.add(slot);
    packed.set(node.id, slot * layoutSpacing.y);
  }

  return packed;
}

function chooseLayerSlot(
  node: LineageNode,
  preferredSlot: number,
  occupiedSlots: Set<number>,
  scoreCandidate: (node: LineageNode, candidateY: number) => number,
): number {
  let bestSlot = preferredSlot;
  let bestScore = Number.POSITIVE_INFINITY;
  const maxRadius = occupiedSlots.size + 12;

  for (let radius = 0; radius <= maxRadius; radius += 1) {
    const offsets = radius === 0 ? [0] : [-radius, radius];
    for (const offset of offsets) {
      const slot = preferredSlot + offset;
      if (occupiedSlots.has(slot)) {
        continue;
      }
      const candidateY = slot * layoutSpacing.y;
      const score = Math.abs(offset) * layoutSpacing.y + scoreCandidate(node, candidateY);
      if (score < bestScore) {
        bestScore = score;
        bestSlot = slot;
      }
    }
  }

  return bestSlot;
}

function scoreEdgeCorridorIntersections(
  nodeId: string,
  depth: number,
  candidateY: number,
  edges: LineageEdge[],
  depthByNode: Map<string, number>,
  yByNode: Map<string, number>,
): number {
  const rect = nodeRect(depth, candidateY, edgeCorridorPadding);
  let penalty = 0;

  for (const edge of edges) {
    if (edge.source === nodeId || edge.target === nodeId) {
      continue;
    }
    const sourceDepth = depthByNode.get(edge.source);
    const targetDepth = depthByNode.get(edge.target);
    const sourceY = yByNode.get(edge.source);
    const targetY = yByNode.get(edge.target);
    if (sourceDepth === undefined || targetDepth === undefined || sourceY === undefined || targetY === undefined) {
      continue;
    }
    if (depth < Math.min(sourceDepth, targetDepth) || depth > Math.max(sourceDepth, targetDepth)) {
      continue;
    }

    const sourcePoint = {
      x: sourceDepth * layoutSpacing.x + nodeSize.width,
      y: sourceY + nodeSize.height / 2,
    };
    const targetPoint = {
      x: targetDepth * layoutSpacing.x,
      y: targetY + nodeSize.height / 2,
    };
    if (segmentIntersectsRect(sourcePoint, targetPoint, rect)) {
      penalty += edgeCorridorPenalty;
    }
  }

  return penalty;
}

function nodeRect(depth: number, y: number, padding = 0): Rect {
  return {
    bottom: y + nodeSize.height + padding,
    left: depth * layoutSpacing.x - padding,
    right: depth * layoutSpacing.x + nodeSize.width + padding,
    top: y - padding,
  };
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
  if (node.type === 'output') return 0;
  if (node.type === 'cte') return 1;
  if (node.type === 'derived') return 2;
  if (node.type === 'scalar_subquery') return 3;
  if (node.type === 'table') return 4;
  if (node.type === 'parameter_table') return 4;
  return 5;
}

function segmentIntersectsRect(start: Point, end: Point, rect: Rect): boolean {
  if (pointInsideRect(start, rect) || pointInsideRect(end, rect)) {
    return true;
  }

  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ];

  return (
    segmentsIntersect(start, end, corners[0], corners[1]) ||
    segmentsIntersect(start, end, corners[1], corners[2]) ||
    segmentsIntersect(start, end, corners[2], corners[3]) ||
    segmentsIntersect(start, end, corners[3], corners[0])
  );
}

function pointInsideRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);

  if (abC === 0 && pointOnSegment(a, b, c)) return true;
  if (abD === 0 && pointOnSegment(a, b, d)) return true;
  if (cdA === 0 && pointOnSegment(c, d, a)) return true;
  if (cdB === 0 && pointOnSegment(c, d, b)) return true;

  return abC !== abD && cdA !== cdB;
}

function orientation(a: Point, b: Point, c: Point): -1 | 0 | 1 {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 0.000_001) {
    return 0;
  }
  return value > 0 ? 1 : -1;
}

function pointOnSegment(a: Point, b: Point, point: Point): boolean {
  return point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
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
  if (edge.kind === 'correlation' || edge.kind === 'predicate_subquery') {
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
