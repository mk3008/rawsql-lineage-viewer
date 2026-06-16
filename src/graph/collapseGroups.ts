import type { LineageColumnRef, LineageEdge, LineageModel, LineageNode } from '../domain/lineage';

export interface CollapsedLineageGroup {
  id: string;
  label: string;
  rootNodeId: string;
  helperNodeIds: string[];
  helperCounts: {
    ctes: number;
    derived: number;
  };
  sourceNodeIds: string[];
  outputColumnCount: number;
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
  return {
    id: `group_${rootNodeId}`,
    label: `Build ${root.label}`,
    rootNodeId,
    helperNodeIds: [...helperNodeIds],
    helperCounts: {
      ctes: helperNodes.filter((node) => node?.type === 'cte').length,
      derived: helperNodes.filter((node) => node?.type === 'derived').length,
    },
    sourceNodeIds: [...sourceNodeIds],
    outputColumnCount: root.columns.length,
  };
}

function isQueryBlockNodeType(type: string) {
  return type === 'cte' || type === 'derived';
}

function isCollapsibleHelperNodeType(type: string) {
  return type === 'cte' || type === 'derived';
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
