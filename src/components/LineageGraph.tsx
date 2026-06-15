import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState } from '@xyflow/react';
import { Eye, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LineageColumn, LineageModel, LineageNode } from '../domain/lineage';
import { buildGraphModel } from '../graph/buildGraphModel';
import { LineageNodeCard } from './LineageNodeCard';

const nodeTypes = {
  lineageNode: LineageNodeCard,
};

interface SelectedColumn {
  columnId: string;
  columnName: string;
  nodeId: string;
}

export function LineageGraph({ lineage }: { lineage: LineageModel }) {
  const previousLineageRef = useRef(lineage);
  const graph = useMemo(() => buildGraphModel(lineage), [lineage]);
  const [hiddenColumnNodeIds, setHiddenColumnNodeIds] = useState<Set<string>>(() => new Set());
  const [selectedColumn, setSelectedColumn] = useState<SelectedColumn | null>(null);
  const [selectedCommentTargetId, setSelectedCommentTargetId] = useState<string | null>(null);
  const allColumnsHidden = hiddenColumnNodeIds.size === lineage.nodes.length;
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
      if (current.size === lineage.nodes.length) {
        return new Set();
      }

      return new Set(lineage.nodes.map((node) => node.id));
    });
  }, [lineage.nodes]);
  const selectNode = useCallback((nodeId: string) => {
    setSelectedCommentTargetId((current) => (current === nodeCommentTargetId(nodeId) ? null : nodeCommentTargetId(nodeId)));
  }, []);
  const selectColumn = useCallback((nodeId: string, column: LineageColumn) => {
    setSelectedCommentTargetId((current) => (current === columnCommentTargetId(column.id) ? null : columnCommentTargetId(column.id)));
    setSelectedColumn((current) =>
      current?.columnId === column.id
        ? null
        : {
            columnId: column.id,
            columnName: column.name,
            nodeId,
          },
    );
  }, []);
  const columnHighlights = useMemo(
    () =>
      selectedColumn
        ? resolveColumnHighlights(lineage.nodes, selectedColumn)
        : { highlightedColumnIds: new Set<string>(), highlightedEdgeIds: new Set<string>(), sourceColumnIds: new Set<string>() },
    [lineage.nodes, selectedColumn],
  );
  const graphNodes = useMemo(
    () =>
      graph.nodes.map((node) => ({
        ...node,
        zIndex: nodeHasSelectedComment(node.data.lineageNode, selectedCommentTargetId) ? 1000 : node.zIndex,
        data: {
          ...node.data,
          columnsVisible: !hiddenColumnNodeIds.has(node.id),
          onToggleColumns: toggleColumns,
          onNodeSelect: selectNode,
          onColumnSelect: selectColumn,
          selectedColumnId: selectedColumn?.columnId ?? null,
          selectedCommentTargetId,
          highlightedColumnIds: columnHighlights.highlightedColumnIds,
          sourceColumnIds: columnHighlights.sourceColumnIds,
        },
      })),
    [
      columnHighlights.highlightedEdgeIds,
      columnHighlights.highlightedColumnIds,
      columnHighlights.sourceColumnIds,
      graph.nodes,
      hiddenColumnNodeIds,
      selectNode,
      selectColumn,
      selectedCommentTargetId,
      selectedColumn?.columnId,
      toggleColumns,
    ],
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
  const [nodes, setNodes, onNodesChange] = useNodesState(graphNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphEdges);

  useEffect(() => {
    if (previousLineageRef.current !== lineage) {
      previousLineageRef.current = lineage;
      setNodes(graphNodes);
      return;
    }

    setNodes((currentNodes) => {
      const currentById = new Map(currentNodes.map((node) => [node.id, node]));
      return graphNodes.map((node) => {
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
    });
  }, [graphNodes, lineage, setNodes]);

  useEffect(() => {
    setEdges(graphEdges);
  }, [graphEdges, setEdges]);

  useEffect(() => {
    setSelectedColumn(null);
    setSelectedCommentTargetId(null);
    setHiddenColumnNodeIds(new Set());
  }, [lineage]);

  return (
    <div className="graph-shell" data-testid="lineage-graph">
      <button className="graph-column-toggle nodrag" type="button" onClick={toggleAllColumns}>
        {allColumnsHidden ? <Eye size={15} /> : <EyeOff size={15} />}
        {allColumnsHidden ? 'Show all columns' : 'Hide all columns'}
      </button>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
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

function nodeHasSelectedComment(node: LineageNode, selectedCommentTargetId: string | null) {
  return (
    selectedCommentTargetId === nodeCommentTargetId(node.id) ||
    node.columns.some((column) => selectedCommentTargetId === columnCommentTargetId(column.id))
  );
}

export function nodeCommentTargetId(nodeId: string) {
  return `node:${nodeId}`;
}

export function columnCommentTargetId(columnId: string) {
  return `column:${columnId}`;
}
