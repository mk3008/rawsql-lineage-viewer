import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  const graph = useMemo(() => buildGraphModel(lineage), [lineage]);
  const [hiddenColumnNodeIds, setHiddenColumnNodeIds] = useState<Set<string>>(() => new Set());
  const [selectedColumn, setSelectedColumn] = useState<SelectedColumn | null>(null);
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
  const selectColumn = useCallback((nodeId: string, column: LineageColumn) => {
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
    () => (selectedColumn ? resolveColumnHighlights(lineage.nodes, selectedColumn) : { highlightedColumnIds: new Set<string>(), sourceColumnIds: new Set<string>() }),
    [lineage.nodes, selectedColumn],
  );
  const graphNodes = useMemo(
    () =>
      graph.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          columnsVisible: !hiddenColumnNodeIds.has(node.id),
          onToggleColumns: toggleColumns,
          onColumnSelect: selectColumn,
          selectedColumnId: selectedColumn?.columnId ?? null,
          highlightedColumnIds: columnHighlights.highlightedColumnIds,
          sourceColumnIds: columnHighlights.sourceColumnIds,
        },
      })),
    [columnHighlights.highlightedColumnIds, columnHighlights.sourceColumnIds, graph.nodes, hiddenColumnNodeIds, selectColumn, selectedColumn?.columnId, toggleColumns],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(graphNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);

  useEffect(() => {
    setNodes(graphNodes);
  }, [graphNodes, setNodes]);

  useEffect(() => {
    setEdges(graph.edges);
  }, [graph.edges, setEdges]);

  useEffect(() => {
    setSelectedColumn(null);
    setHiddenColumnNodeIds(new Set());
  }, [lineage]);

  return (
    <div className="graph-shell" data-testid="lineage-graph">
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

function resolveColumnHighlights(nodes: LineageNode[], selectedColumn: SelectedColumn): { highlightedColumnIds: Set<string>; sourceColumnIds: Set<string> } {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const highlightedColumnIds = new Set<string>();
  const sourceColumnIds = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeId: string, columnName: string): boolean => {
    const node = nodesById.get(nodeId);
    const column = node?.columns.find((item) => item.name === columnName);
    if (!column || visited.has(column.id)) {
      return false;
    }

    visited.add(column.id);
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
      resolvedAny = visit(ref.nodeId, ref.columnName) || resolvedAny;
    }

    if (!resolvedAny) {
      sourceColumnIds.add(column.id);
    }
    return true;
  };

  visit(selectedColumn.nodeId, selectedColumn.columnName);
  sourceColumnIds.delete(selectedColumn.columnId);
  return { highlightedColumnIds, sourceColumnIds };
}
