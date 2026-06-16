import {
  Background,
  BaseEdge,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getBezierPath,
  useEdgesState,
  useNodesState,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { Eye, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LineageColumn, LineageModel, LineageNode } from '../domain/lineage';
import { buildGraphModel } from '../graph/buildGraphModel';
import { collectCollapsibleUpstreamGroups, collapseLineageGroups } from '../graph/collapseGroups';
import { LineageNodeCard } from './LineageNodeCard';

const nodeTypes = {
  groupFrame: GroupFrameNode,
  lineageNode: LineageNodeCard,
};

const edgeTypes = {
  lineageDataFlow: LineageDataFlowEdge,
};

interface SelectedColumn {
  columnId: string;
  columnName: string;
  nodeId: string;
}

interface GroupFrameData extends Record<string, unknown> {
  label: string;
  summary: string;
}

export function LineageGraph({ lineage }: { lineage: LineageModel }) {
  const previousLineageRef = useRef(lineage);
  const [collapsedGroupRootIds, setCollapsedGroupRootIds] = useState<Set<string>>(() => new Set());
  const collapsibleGroups = useMemo(() => collectCollapsibleUpstreamGroups(lineage), [lineage]);
  const collapsedLineage = useMemo(() => collapseLineageGroups(lineage, collapsedGroupRootIds), [collapsedGroupRootIds, lineage]);
  const viewLineage = collapsedLineage.lineage;
  const graph = useMemo(() => buildGraphModel(viewLineage), [viewLineage]);
  const [hiddenColumnNodeIds, setHiddenColumnNodeIds] = useState<Set<string>>(() => new Set());
  const [selectedColumn, setSelectedColumn] = useState<SelectedColumn | null>(null);
  const [selectedNodeCommentTargetId, setSelectedNodeCommentTargetId] = useState<string | null>(null);
  const [activeCommentTargetId, setActiveCommentTargetId] = useState<string | null>(null);
  const [dismissedCommentTargetIds, setDismissedCommentTargetIds] = useState<Set<string>>(() => new Set());
  const [showColumnCallouts, setShowColumnCallouts] = useState(true);
  const [showHeaderCallouts, setShowHeaderCallouts] = useState(true);
  const [viewportZoom, setViewportZoom] = useState(1);
  const allColumnsHidden = hiddenColumnNodeIds.size === viewLineage.nodes.length;
  const toggleColumns = useCallback((nodeId: string) => {
    setHiddenColumnNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);
  const toggleAllColumns = useCallback(() => {
    setHiddenColumnNodeIds((current) => {
      if (current.size === viewLineage.nodes.length) {
        return new Set();
      }

      return new Set(viewLineage.nodes.map((node) => node.id));
    });
  }, [viewLineage.nodes]);
  const collapseUpstream = useCallback((nodeId: string) => {
    setCollapsedGroupRootIds((current) => new Set(current).add(nodeId));
    setSelectedColumn(null);
    setSelectedNodeCommentTargetId(null);
    setActiveCommentTargetId(null);
    setDismissedCommentTargetIds(new Set());
  }, []);
  const expandGroup = useCallback((nodeId: string) => {
    setCollapsedGroupRootIds((current) => {
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
    setSelectedColumn(null);
    setSelectedNodeCommentTargetId(null);
    setActiveCommentTargetId(null);
    setDismissedCommentTargetIds(new Set());
  }, []);
  const selectNode = useCallback((nodeId: string) => {
    setSelectedColumn(null);
    setDismissedCommentTargetIds(new Set());
    const targetId = nodeCommentTargetId(nodeId);
    setSelectedNodeCommentTargetId((current) => {
      const next = current === targetId ? null : targetId;
      setActiveCommentTargetId(next);
      return next;
    });
  }, []);
  const selectColumn = useCallback((nodeId: string, column: LineageColumn) => {
    setSelectedNodeCommentTargetId(null);
    setDismissedCommentTargetIds(new Set());
    const targetId = columnCommentTargetId(column.id);
    setSelectedColumn((current) => {
      if (current?.columnId === column.id) {
        setActiveCommentTargetId(null);
        return null;
      }

      setActiveCommentTargetId(targetId);
      return {
        columnId: column.id,
        columnName: column.name,
        nodeId,
      };
    });
  }, []);
  const closeComment = useCallback((targetId: string) => {
    setDismissedCommentTargetIds((current) => new Set(current).add(targetId));
    setActiveCommentTargetId((current) => (current === targetId ? null : current));
  }, []);
  const focusComment = useCallback((targetId: string) => {
    setActiveCommentTargetId(targetId);
  }, []);
  const columnHighlights = useMemo(
    () =>
      selectedColumn
        ? resolveColumnHighlights(viewLineage.nodes, selectedColumn)
        : { highlightedColumnIds: new Set<string>(), highlightedEdgeIds: new Set<string>(), sourceColumnIds: new Set<string>() },
    [selectedColumn, viewLineage.nodes],
  );
  const selectedCommentTargetIds = useMemo(() => {
    if (selectedColumn) {
      if (!showColumnCallouts) {
        return new Set<string>();
      }

      const targetIds = new Set([
        columnCommentTargetId(selectedColumn.columnId),
        ...[...columnHighlights.highlightedColumnIds].map(columnCommentTargetId),
        ...[...columnHighlights.sourceColumnIds].map(columnCommentTargetId),
      ]);
      for (const dismissedTargetId of dismissedCommentTargetIds) {
        targetIds.delete(dismissedTargetId);
      }
      return targetIds;
    }

    if (showHeaderCallouts && selectedNodeCommentTargetId && !dismissedCommentTargetIds.has(selectedNodeCommentTargetId)) {
      return new Set([selectedNodeCommentTargetId]);
    }

    return new Set<string>();
  }, [
    columnHighlights.highlightedColumnIds,
    columnHighlights.sourceColumnIds,
    dismissedCommentTargetIds,
    selectedColumn,
    selectedNodeCommentTargetId,
    showColumnCallouts,
    showHeaderCallouts,
  ]);
  const lineageGraphNodes = useMemo(
    () =>
      graph.nodes.map((node) => ({
        ...node,
        zIndex: nodeHasSelectedComment(node.data.lineageNode, selectedCommentTargetIds) ? 1000 : node.zIndex,
        data: {
          ...node.data,
          canCollapseUpstream: collapsibleGroups.has(node.id),
          collapsedGroup: collapsedLineage.groups.get(node.id),
          columnsVisible: !hiddenColumnNodeIds.has(node.id),
          onCollapseUpstream: collapseUpstream,
          onExpandGroup: expandGroup,
          onToggleColumns: toggleColumns,
          onNodeSelect: selectNode,
          onColumnSelect: selectColumn,
          selectedColumnId: selectedColumn?.columnId ?? null,
          selectedCommentTargetIds,
          activeCommentTargetId,
          viewportZoom,
          highlightedColumnIds: columnHighlights.highlightedColumnIds,
          sourceColumnIds: columnHighlights.sourceColumnIds,
          onCommentClose: closeComment,
          onCommentFocus: focusComment,
        },
      })),
    [
      columnHighlights.highlightedEdgeIds,
      columnHighlights.highlightedColumnIds,
      columnHighlights.sourceColumnIds,
      collapseUpstream,
      collapsedLineage.groups,
      collapsibleGroups,
      expandGroup,
      graph.nodes,
      hiddenColumnNodeIds,
      selectNode,
      selectColumn,
      closeComment,
      focusComment,
      activeCommentTargetId,
      viewportZoom,
      selectedColumn?.columnId,
      selectedCommentTargetIds,
      toggleColumns,
    ],
  );
  const graphNodes = useMemo(
    () => addGroupFrameNodes(lineageGraphNodes, collapsibleGroups, collapsedGroupRootIds),
    [collapsedGroupRootIds, collapsibleGroups, lineageGraphNodes],
  );
  const graphEdges = useMemo(
    () =>
      graph.edges.map((edge) => {
        if (!columnHighlights.highlightedEdgeIds.has(edge.id)) {
          return edge;
        }

        const baseStyle = edge.style ?? {};
        return {
          ...edge,
          animated: false,
          style: {
            ...baseStyle,
            stroke: '#2563eb',
            strokeWidth: 5,
          },
          markerEnd:
            edge.markerEnd && typeof edge.markerEnd === 'object'
              ? {
                  ...edge.markerEnd,
                  color: '#2563eb',
                }
              : edge.markerEnd,
        };
      }),
    [columnHighlights.highlightedEdgeIds, graph.edges],
  );
  const [nodes, setNodes] = useNodesState(graphNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphEdges);
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((currentNodes) => {
        const nextNodes = applyNodeChanges(changes, currentNodes);
        const shouldRecalculateFrames = changes.some((change) => change.type === 'position' || change.type === 'remove');
        return shouldRecalculateFrames ? addGroupFrameNodes(nextNodes, collapsibleGroups, collapsedGroupRootIds) : nextNodes;
      });
    },
    [collapsedGroupRootIds, collapsibleGroups, setNodes],
  );

  useEffect(() => {
    if (previousLineageRef.current !== lineage) {
      previousLineageRef.current = lineage;
      setNodes(graphNodes);
      return;
    }

    setNodes((currentNodes) => {
      const currentById = new Map(currentNodes.map((node) => [node.id, node]));
      const nextLineageNodes = graphNodes.filter((node) => node.type === 'lineageNode').map((node) => {
        const current = currentById.get(node.id);
        if (!current) {
          return node;
        }

        return {
          ...node,
          dragging: current.dragging,
          measured: current.measured,
          position: current.position,
          selected: current.selected,
        };
      });
      return addGroupFrameNodes(nextLineageNodes, collapsibleGroups, collapsedGroupRootIds);
    });
  }, [collapsedGroupRootIds, collapsibleGroups, graphNodes, lineage, setNodes]);

  useEffect(() => {
    setEdges(graphEdges);
  }, [graphEdges, setEdges]);

  useEffect(() => {
    setSelectedColumn(null);
    setSelectedNodeCommentTargetId(null);
    setActiveCommentTargetId(null);
    setDismissedCommentTargetIds(new Set());
    setHiddenColumnNodeIds(new Set());
    setCollapsedGroupRootIds(new Set());
  }, [lineage]);

  return (
    <div className="graph-shell" data-testid="lineage-graph">
      <div className="graph-display-controls nodrag" aria-label="Graph display options">
        <button className="graph-column-toggle" type="button" onClick={toggleAllColumns}>
          {allColumnsHidden ? <Eye size={15} /> : <EyeOff size={15} />}
          {allColumnsHidden ? 'Show all columns' : 'Hide all columns'}
        </button>
        <label className="graph-callout-toggle">
          <input type="checkbox" checked={showColumnCallouts} onChange={(event) => setShowColumnCallouts(event.target.checked)} />
          Column callouts
        </label>
        <label className="graph-callout-toggle">
          <input type="checkbox" checked={showHeaderCallouts} onChange={(event) => setShowHeaderCallouts(event.target.checked)} />
          Header callouts
        </label>
      </div>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={(instance) => setViewportZoom(instance.getZoom())}
          onMove={(_, viewport) => setViewportZoom(viewport.zoom)}
          nodesDraggable
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.35}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#d7deea" gap={18} size={1} />
          <Controls position="top-right" showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => {
              if (node.type === 'groupFrame') return '#e0f2fe';
              const type = (node.data as { lineageNode?: { type?: string } } | undefined)?.lineageNode?.type;
              if (type === 'table') return '#dbeafe';
              if (type === 'cte') return '#dcfce7';
              if (type === 'output') return '#f3e8ff';
              return '#fef3c7';
            }}
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

function GroupFrameNode({ data }: NodeProps<Node<GroupFrameData, 'groupFrame'>>) {
  return (
    <div className="lineage-group-frame" data-testid="lineage-group-frame">
      <div className="lineage-group-frame-label">{data.label}</div>
      <div className="lineage-group-frame-summary">{data.summary}</div>
    </div>
  );
}

function addGroupFrameNodes(
  nodes: Node[],
  collapsibleGroups: ReturnType<typeof collectCollapsibleUpstreamGroups>,
  collapsedGroupRootIds: Set<string>,
): Node[] {
  const lineageNodes = nodes.filter((node) => node.type === 'lineageNode');
  const frameNodes = [...collapsibleGroups.values()].flatMap((group) => {
    if (collapsedGroupRootIds.has(group.rootNodeId)) {
      return [];
    }

    const memberNodeIds = new Set([group.rootNodeId, ...group.helperNodeIds]);
    const memberNodes = lineageNodes.filter((node) => memberNodeIds.has(node.id));
    if (memberNodes.length !== memberNodeIds.size) {
      return [];
    }

    const bounds = calculateGroupFrameBounds(memberNodes);
    if (!bounds) {
      return [];
    }

    return [
      {
        id: `group-frame-${group.rootNodeId}`,
        type: 'groupFrame',
        position: { x: bounds.x, y: bounds.y },
        draggable: false,
        selectable: false,
        connectable: false,
        deletable: false,
        focusable: false,
        zIndex: -10,
        data: {
          label: group.label,
          summary: formatGroupFrameSummary(group.helperCounts),
        },
        style: {
          height: bounds.height,
          pointerEvents: 'none',
          width: bounds.width,
        },
      } satisfies Node<GroupFrameData, 'groupFrame'>,
    ];
  });

  return [...frameNodes, ...lineageNodes];
}

function calculateGroupFrameBounds(nodes: Node[]) {
  if (nodes.length === 0) {
    return null;
  }

  const padding = 42;
  const rects = nodes.map((node) => {
    const size = estimateNodeSize(node);
    return {
      bottom: node.position.y + size.height,
      left: node.position.x,
      right: node.position.x + size.width,
      top: node.position.y,
    };
  });
  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));

  return {
    height: bottom - top + padding * 2,
    width: right - left + padding * 2,
    x: left - padding,
    y: top - padding,
  };
}

function estimateNodeSize(node: Node) {
  const lineageNode = (node.data as { lineageNode?: LineageNode }).lineageNode;
  if (!lineageNode) {
    return { height: 120, width: 220 };
  }

  const baseHeight = 50;
  const columnHeight = 40;
  const emptyBodyHeight = 40;
  const bodyHeight = lineageNode.columns.length > 0 ? lineageNode.columns.length * columnHeight : emptyBodyHeight;
  return {
    height: Math.max(118, baseHeight + bodyHeight),
    width: 220,
  };
}

function formatGroupFrameSummary(helperCounts: { ctes: number; derived: number }) {
  const parts = [
    helperCounts.ctes > 0 ? `${helperCounts.ctes} CTE${helperCounts.ctes === 1 ? '' : 's'}` : null,
    helperCounts.derived > 0 ? `${helperCounts.derived} derived` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `Can collapse ${parts.join(' + ')}` : 'Can collapse internals';
}

function resolveColumnHighlights(
  nodes: LineageNode[],
  selectedColumn: SelectedColumn,
): { highlightedColumnIds: Set<string>; highlightedEdgeIds: Set<string>; sourceColumnIds: Set<string> } {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const downstreamByColumnKey = new Map<string, Array<{ columnName: string; nodeId: string }>>();
  const highlightedColumnIds = new Set<string>();
  const highlightedEdgeIds = new Set<string>();
  const sourceColumnIds = new Set<string>();
  const visitedUpstream = new Set<string>();
  const visitedDownstream = new Set<string>();

  for (const node of nodes) {
    for (const column of node.columns) {
      for (const upstream of column.upstream ?? []) {
        const key = columnKey(upstream.nodeId, upstream.columnName);
        downstreamByColumnKey.set(key, [...(downstreamByColumnKey.get(key) ?? []), { columnName: column.name, nodeId: node.id }]);
      }
    }
  }

  const visitUpstream = (nodeId: string, columnName: string): boolean => {
    const node = nodesById.get(nodeId);
    const column = node?.columns.find((item) => item.name === columnName);
    if (!column || visitedUpstream.has(column.id)) {
      return false;
    }

    visitedUpstream.add(column.id);
    if (column.id !== selectedColumn.columnId) {
      highlightedColumnIds.add(column.id);
    }

    const upstream = column.upstream ?? [];
    if (upstream.length === 0) {
      sourceColumnIds.add(column.id);
      return true;
    }

    let resolvedAny = false;
    for (const ref of upstream) {
      highlightedEdgeIds.add(edgeKey(ref.nodeId, nodeId));
      resolvedAny = visitUpstream(ref.nodeId, ref.columnName) || resolvedAny;
    }

    if (!resolvedAny) {
      sourceColumnIds.add(column.id);
    }
    return true;
  };

  const visitDownstream = (nodeId: string, columnName: string) => {
    const node = nodesById.get(nodeId);
    const column = node?.columns.find((item) => item.name === columnName);
    if (!column || visitedDownstream.has(column.id)) {
      return;
    }

    visitedDownstream.add(column.id);
    const downstream = downstreamByColumnKey.get(columnKey(nodeId, columnName)) ?? [];
    for (const ref of downstream) {
      const downstreamNode = nodesById.get(ref.nodeId);
      const downstreamColumn = downstreamNode?.columns.find((item) => item.name === ref.columnName);
      if (!downstreamColumn) {
        continue;
      }

      highlightedColumnIds.add(downstreamColumn.id);
      highlightedEdgeIds.add(edgeKey(nodeId, ref.nodeId));
      visitDownstream(ref.nodeId, ref.columnName);
    }
  };

  visitUpstream(selectedColumn.nodeId, selectedColumn.columnName);
  visitDownstream(selectedColumn.nodeId, selectedColumn.columnName);
  highlightedColumnIds.delete(selectedColumn.columnId);
  sourceColumnIds.delete(selectedColumn.columnId);
  return { highlightedColumnIds, highlightedEdgeIds, sourceColumnIds };
}

function columnKey(nodeId: string, columnName: string) {
  return `${nodeId}:${columnName}`;
}

function edgeKey(sourceId: string, targetId: string) {
  return `${sourceId}-${targetId}`;
}

function nodeHasSelectedComment(node: LineageNode, selectedCommentTargetIds: Set<string>) {
  return (
    selectedCommentTargetIds.has(nodeCommentTargetId(node.id)) ||
    node.columns.some((column) => selectedCommentTargetIds.has(columnCommentTargetId(column.id)))
  );
}

export function nodeCommentTargetId(nodeId: string) {
  return `node:${nodeId}`;
}

export function columnCommentTargetId(columnId: string) {
  return `column:${columnId}`;
}

function LineageDataFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  labelBgPadding,
  labelBgBorderRadius,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={style}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
    />
  );
}
