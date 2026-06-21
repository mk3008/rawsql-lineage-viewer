import type { LineageColumnRef, LineageEdge, LineageModel, LineageNode, LineagePopulationEffect } from '../domain/lineage';

export interface CollapsedLineageGroup {
  id: string;
  label: string;
  rootNodeId: string;
  helperNodes: {
    id: string;
    label: string;
    type: 'cte' | 'derived';
  }[];
  helperNodeIds: string[];
  helperCounts: {
    ctes: number;
    derived: number;
  };
  sourceNodeIds: string[];
  outputColumnCount: number;
  summary: {
    operations: string[];
    groupBy: string[];
    inputs: string[];
  };
  populationEffects: {
    self: LineagePopulationEffect[];
    descendants: LineagePopulationEffect[];
  };
}

export interface CollapsedLineageResult {
  groups: Map<string, CollapsedLineageGroup>;
  lineage: LineageModel;
}

export function collectCollapsibleUpstreamGroups(lineage: LineageModel): Map<string, CollapsedLineageGroup> {
  const result = new Map<string, CollapsedLineageGroup>();
  for (const node of lineage.nodes) {
    if (!isQueryBlockNodeType(node.type)) {
      continue;
    }

    const group = collectCollapsibleUpstreamGroup(lineage, node.id);
    if (group) {
      result.set(node.id, group);
    }
  }
  return result;
}

export function collectDefaultCollapsedGroupRootIds(lineage: LineageModel): Set<string> {
  const groups = collectCollapsibleUpstreamGroups(lineage);
  const nodesById = new Map(lineage.nodes.map((node) => [node.id, node]));
  const candidateRootIds = new Set<string>();

  for (const group of groups.values()) {
    if (isMeaningfulCollapsedStep(nodesById.get(group.rootNodeId), group)) {
      candidateRootIds.add(group.rootNodeId);
    }
  }

  const nestedRootIds = new Set<string>();
  for (const rootNodeId of candidateRootIds) {
    const group = groups.get(rootNodeId);
    for (const helperNodeId of group?.helperNodeIds ?? []) {
      if (candidateRootIds.has(helperNodeId)) {
        nestedRootIds.add(helperNodeId);
      }
    }
  }

  return new Set([...candidateRootIds].filter((rootNodeId) => !nestedRootIds.has(rootNodeId)));
}

export function collapseLineageGroups(lineage: LineageModel, rootNodeIds: Set<string>): CollapsedLineageResult {
  const availableGroups = collectCollapsibleUpstreamGroups(lineage);
  const groups = new Map<string, CollapsedLineageGroup>();
  for (const rootNodeId of rootNodeIds) {
    const group = availableGroups.get(rootNodeId);
    if (group) {
      groups.set(rootNodeId, group);
    }
  }

  if (groups.size === 0) {
    return { lineage, groups };
  }

  const hiddenNodeIds = new Set([...groups.values()].flatMap((group) => group.helperNodeIds));
  const rootByHiddenNodeId = new Map<string, string>();
  for (const group of groups.values()) {
    for (const helperNodeId of group.helperNodeIds) {
      rootByHiddenNodeId.set(helperNodeId, group.rootNodeId);
    }
  }

  const nodesById = new Map(lineage.nodes.map((node) => [node.id, node]));
  const nodes = lineage.nodes
    .filter((node) => !hiddenNodeIds.has(node.id))
    .map((node) => {
      const group = groups.get(node.id);
      if (!group) {
        return node;
      }

      return {
        ...node,
        label: group.label,
        columns: collapseRootColumns(node, nodesById, hiddenNodeIds),
      };
    });

  const edges = dedupeCollapsedEdges(
    lineage.edges.flatMap((edge) => collapseEdge(edge, hiddenNodeIds, rootByHiddenNodeId)),
  );

  return {
    groups,
    lineage: {
      ...lineage,
      nodes,
      edges,
    },
  };
}

function collapseRootColumns(
  rootNode: LineageNode,
  nodesById: Map<string, LineageNode>,
  hiddenNodeIds: Set<string>,
): LineageNode['columns'] {
  return rootNode.columns.map((column) => ({
    ...column,
    upstream: collapseColumnRefs(column.upstream ?? [], nodesById, hiddenNodeIds, new Set()),
  }));
}

function collapseColumnRefs(
  refs: LineageColumnRef[],
  nodesById: Map<string, LineageNode>,
  hiddenNodeIds: Set<string>,
  visitedColumnKeys: Set<string>,
): LineageColumnRef[] {
  const collapsedRefs = refs.flatMap((ref) => {
    if (!hiddenNodeIds.has(ref.nodeId)) {
      return [ref];
    }

    const key = `${ref.nodeId}:${ref.columnName}`;
    if (visitedColumnKeys.has(key)) {
      return [];
    }

    const hiddenNode = nodesById.get(ref.nodeId);
    const hiddenColumn = hiddenNode?.columns.find((column) => column.name === ref.columnName);
    if (!hiddenColumn) {
      return [];
    }

    const nextVisited = new Set(visitedColumnKeys).add(key);
    return collapseColumnRefs(hiddenColumn.upstream ?? [], nodesById, hiddenNodeIds, nextVisited);
  });

  return dedupeColumnRefs(collapsedRefs);
}

function dedupeColumnRefs(refs: LineageColumnRef[]): LineageColumnRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.nodeId}:${ref.columnName}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectCollapsibleUpstreamGroup(lineage: LineageModel, rootNodeId: string): CollapsedLineageGroup | null {
  const nodesById = new Map(lineage.nodes.map((node) => [node.id, node]));
  const root = nodesById.get(rootNodeId);
  if (!root || !isQueryBlockNodeType(root.type)) {
    return null;
  }
  if (root.recursive || root.dependencyProfile?.isRecursive) {
    return null;
  }

  const dataFlowEdges = lineage.edges.filter((edge) => edge.type === 'dataFlow');
  const incomingByTarget = groupEdgesBy(dataFlowEdges, 'target');
  const outgoingBySource = groupEdgesBy(dataFlowEdges, 'source');
  const helperNodeIds = new Set<string>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const targetNodeId of [rootNodeId, ...helperNodeIds]) {
      for (const edge of incomingByTarget.get(targetNodeId) ?? []) {
        const sourceNode = nodesById.get(edge.source);
        if (!sourceNode || !isCollapsibleHelperNodeType(sourceNode.type) || sourceNode.id === rootNodeId || helperNodeIds.has(sourceNode.id)) {
          continue;
        }

        const isOnlyUsedInsideGroup = (outgoingBySource.get(sourceNode.id) ?? []).every(
          (outgoing) => outgoing.target === rootNodeId || helperNodeIds.has(outgoing.target),
        );
        if (isOnlyUsedInsideGroup) {
          helperNodeIds.add(sourceNode.id);
          changed = true;
        }
      }
    }
  }

  if (helperNodeIds.size === 0) {
    return null;
  }

  const sourceNodeIds = new Set<string>();
  for (const helperNodeId of helperNodeIds) {
    for (const edge of incomingByTarget.get(helperNodeId) ?? []) {
      if (!helperNodeIds.has(edge.source) && edge.source !== rootNodeId) {
        sourceNodeIds.add(edge.source);
      }
    }
  }

  const helperNodes = [...helperNodeIds].map((helperNodeId) => nodesById.get(helperNodeId));
  const visibleHelperNodes = helperNodes.filter((node): node is LineageNode & { type: 'cte' | 'derived' } =>
    node ? isCollapsibleHelperNodeType(node.type) : false,
  );
  const selfPopulationEffects = uniquePopulationEffects(root.dependencyProfile?.populationEffects ?? []);
  const descendantPopulationEffects = uniquePopulationEffects(
    visibleHelperNodes.flatMap((node) => node.dependencyProfile?.populationEffects ?? []),
  );
  return {
    id: `group_${rootNodeId}`,
    label: root.label,
    rootNodeId,
    helperNodes: visibleHelperNodes.map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
    })),
    helperNodeIds: [...helperNodeIds],
    helperCounts: {
      ctes: visibleHelperNodes.filter((node) => node.type === 'cte').length,
      derived: visibleHelperNodes.filter((node) => node.type === 'derived').length,
    },
    sourceNodeIds: [...sourceNodeIds],
    outputColumnCount: root.columns.length,
    summary: buildGroupSummary(root, visibleHelperNodes),
    populationEffects: {
      self: selfPopulationEffects,
      descendants: descendantPopulationEffects,
    },
  };
}

function isQueryBlockNodeType(type: string) {
  return type === 'cte' || type === 'derived';
}

function isCollapsibleHelperNodeType(type: string) {
  return type === 'cte' || type === 'derived';
}

function buildGroupSummary(root: LineageNode, helperNodes: LineageNode[]): CollapsedLineageGroup['summary'] {
  return {
    operations: uniqueStrings(root.columns.map((column) => summarizeColumnOperation(column.expressionSql)).filter(isString)),
    groupBy: uniqueStrings(root.columns
      .filter((column) => column.usage?.reasons?.includes('groupBy'))
      .map((column) => column.name)),
    inputs: uniqueStrings(helperNodes.map((node) => node.label)),
  };
}

function summarizeColumnOperation(expressionSql: string | undefined): string | null {
  if (!expressionSql) {
    return null;
  }
  const trimmed = expressionSql.trim();
  const aggregateMatch = trimmed.match(/\b(count|sum|avg|min|max)\s*\(([^)]*)\)/i);
  if (aggregateMatch) {
    return `${aggregateMatch[1].toLowerCase()}(${aggregateMatch[2].trim()})`;
  }
  if (!/^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/.test(trimmed)) {
    return trimmed.length > 64 ? `${trimmed.slice(0, 61)}...` : trimmed;
  }
  return null;
}

function hasAggregateExpression(node: LineageNode): boolean {
  return node.columns.some((column) => /\b(count|sum|avg|min|max)\s*\(/i.test(column.expressionSql ?? ''));
}

function hasPreparedDetailProjection(node: LineageNode): boolean {
  return node.columns.some((column) =>
    Boolean(column.expressionSql && !/^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?$/.test(column.expressionSql.trim())),
  );
}

function isMeaningfulCollapsedStep(node: LineageNode | undefined, group: CollapsedLineageGroup): boolean {
  const profile = node?.dependencyProfile;
  if (!node || !profile || !isCollapsibleHelperNodeType(node.type) || group.helperNodeIds.length === 0) {
    return false;
  }

  if (profile.isRecursive || profile.hasSetOperation) {
    return false;
  }

  return profile.inputNodeCount >= 1
    && profile.consumerNodeCount <= 1
    && (
      profile.hasGroupBy
      || profile.hasHaving
      || profile.hasWhere
      || profile.hasJoin
      || hasAggregateExpression(node)
      || hasPreparedDetailProjection(node)
    );
}

function uniquePopulationEffects(effects: LineagePopulationEffect[]): LineagePopulationEffect[] {
  return [...new Set(effects)].sort();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

function collapseEdge(edge: LineageEdge, hiddenNodeIds: Set<string>, rootByHiddenNodeId: Map<string, string>): LineageEdge[] {
  const sourceRoot = rootByHiddenNodeId.get(edge.source);
  const targetRoot = rootByHiddenNodeId.get(edge.target);

  if (sourceRoot && targetRoot && sourceRoot === targetRoot) {
    return [];
  }

  if (sourceRoot && edge.target === sourceRoot) {
    return [];
  }

  if (hiddenNodeIds.has(edge.source) && hiddenNodeIds.has(edge.target)) {
    return [];
  }

  const nextSource = sourceRoot ?? edge.source;
  const nextTarget = targetRoot ?? edge.target;
  if (nextSource === nextTarget) {
    return [];
  }

  return [
    {
      ...edge,
      id: `${nextSource}-${nextTarget}`,
      source: nextSource,
      target: nextTarget,
    },
  ];
}

function dedupeCollapsedEdges(edges: LineageEdge[]): LineageEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}|${edge.target}|${edge.type}|${edge.sourceAlias ?? ''}|${edge.joinNullability?.joinType ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function groupEdgesBy(edges: LineageEdge[], key: 'source' | 'target'): Map<string, LineageEdge[]> {
  const result = new Map<string, LineageEdge[]>();
  for (const edge of edges) {
    result.set(edge[key], [...(result.get(edge[key]) ?? []), edge]);
  }
  return result;
}
