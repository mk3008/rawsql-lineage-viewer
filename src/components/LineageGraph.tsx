import {
  Background,
  BaseEdge,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useEdgesState,
  useNodesState,
  type EdgeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import { Copy, ExternalLink, Eye, EyeOff, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphEdge, GraphNode } from '../domain/graph';
import type { LineageColumn, LineageEdge, LineageModel, LineageNode } from '../domain/lineage';
import { buildGraphModel, type GraphFlowDirection } from '../graph/buildGraphModel';
import { collectCollapsibleUpstreamGroups, collapseLineageGroups } from '../graph/collapseGroups';
import { isSimpleColumnReference } from '../lineage/columnDisplay';
import { LineageNodeCard } from './LineageNodeCard';

const nodeTypes = {
  lineageNode: LineageNodeCard,
};

const edgeTypes = {
  lineageDataFlow: LineageDataFlowEdge,
};

const defaultViewport = { x: 16, y: 72, zoom: 1 };

interface SelectedColumn {
  columnId: string;
  columnName: string;
  nodeId: string;
}

export type InspectorSelection =
  | {
      kind: 'column';
      selected: InspectorColumnItem;
      sources: InspectorColumnItem[];
      upstream: InspectorColumnItem[];
      upstreamGroups: InspectorColumnGroup[];
      downstream: InspectorColumnItem[];
    }
  | {
      kind: 'node';
      node: LineageNode;
    }
  | null;

interface InspectorColumnItem {
  column: LineageColumn;
  node: LineageNode;
}

interface InspectorColumnGroup {
  alias?: string;
  items: InspectorColumnItem[];
}

export function LineageGraph({
  focusTarget,
  flowDirection,
  lineage,
  onInspectorSelectionChange,
}: {
  focusTarget?: { nonce: number; nodeId: string } | null;
  flowDirection: GraphFlowDirection;
  lineage: LineageModel;
  onInspectorSelectionChange?: (selection: InspectorSelection) => void;
}) {
  const previousLineageRef = useRef(lineage);
  const previousFlowDirectionRef = useRef(flowDirection);
  const graphShellRef = useRef<HTMLDivElement | null>(null);
  const nodePositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const flowInstanceRef = useRef<ReactFlowInstance<GraphNode, GraphEdge> | null>(null);
  const [collapsedGroupRootIds, setCollapsedGroupRootIds] = useState<Set<string>>(() => new Set());
  const collapsibleGroups = useMemo(() => collectCollapsibleUpstreamGroups(lineage), [lineage]);
  const collapsedLineage = useMemo(() => collapseLineageGroups(lineage, collapsedGroupRootIds), [collapsedGroupRootIds, lineage]);
  const viewLineage = collapsedLineage.lineage;
  const graph = useMemo(() => buildGraphModel(viewLineage, flowDirection), [flowDirection, viewLineage]);
  const [hiddenColumnNodeIds, setHiddenColumnNodeIds] = useState<Set<string>>(() => new Set());
  const [selectedColumn, setSelectedColumn] = useState<SelectedColumn | null>(null);
  const [selectedNodeCommentTargetId, setSelectedNodeCommentTargetId] = useState<string | null>(null);
  const [activeCommentTargetId, setActiveCommentTargetId] = useState<string | null>(null);
  const [dismissedCommentTargetIds, setDismissedCommentTargetIds] = useState<Set<string>>(() => new Set());
  const [showColumnCallouts, setShowColumnCallouts] = useState(true);
  const [showHeaderCallouts, setShowHeaderCallouts] = useState(true);
  const [showUnusedColumns, setShowUnusedColumns] = useState(true);
  const [expandedPassthroughNodeIds, setExpandedPassthroughNodeIds] = useState<Set<string>>(() => new Set());
  const [viewportZoom, setViewportZoom] = useState(1);
  const resetZoom = useCallback(() => {
    void flowInstanceRef.current?.setViewport(defaultViewport, { duration: 120 });
    setViewportZoom(1);
  }, []);
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
  const togglePassthroughColumns = useCallback((nodeId: string) => {
    setExpandedPassthroughNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);
  const collapseUpstream = useCallback((nodeId: string) => {
    setCollapsedGroupRootIds((current) => new Set(current).add(nodeId));
  }, []);
  const expandGroup = useCallback((nodeId: string) => {
    setCollapsedGroupRootIds((current) => {
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
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
  const inspectorSelection = useMemo<InspectorSelection>(() => {
    if (selectedColumn) {
      return resolveInspectorColumnSelection(viewLineage.nodes, viewLineage.edges, selectedColumn);
    }

    if (selectedNodeCommentTargetId) {
      const nodeId = selectedNodeCommentTargetId.replace(/^node:/, '');
      const node = viewLineage.nodes.find((item) => item.id === nodeId);
      return node ? { kind: 'node', node } : null;
    }

    return null;
  }, [selectedColumn, selectedNodeCommentTargetId, viewLineage.nodes]);
  useEffect(() => {
    onInspectorSelectionChange?.(inspectorSelection);
  }, [inspectorSelection, onInspectorSelectionChange]);
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
  const graphNodes = useMemo<GraphNode[]>(
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
          onTogglePassthroughColumns: togglePassthroughColumns,
          passthroughColumnsCompressed: node.data.lineageNode.type !== 'output' && !expandedPassthroughNodeIds.has(node.id),
          showUnusedColumns,
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
      expandedPassthroughNodeIds,
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
      showUnusedColumns,
      toggleColumns,
      togglePassthroughColumns,
    ],
  );
  const graphEdges = useMemo<GraphEdge[]>(
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
    if (previousLineageRef.current !== lineage || previousFlowDirectionRef.current !== flowDirection) {
      previousLineageRef.current = lineage;
      previousFlowDirectionRef.current = flowDirection;
      nodePositionsRef.current = new Map(graphNodes.map((node) => [node.id, node.position]));
      setNodes(graphNodes);
      return;
    }

    setNodes((currentNodes) => {
      const currentById = new Map(currentNodes.map((node) => [node.id, node]));
      return graphNodes.map((node) => {
        const current = currentById.get(node.id);
        if (!current) {
          return {
            ...node,
            position: nodePositionsRef.current.get(node.id) ?? node.position,
          };
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
  }, [flowDirection, graphNodes, lineage, setNodes]);

  useEffect(() => {
    for (const node of nodes) {
      nodePositionsRef.current.set(node.id, node.position);
    }
  }, [nodes]);

  useEffect(() => {
    setEdges(graphEdges);
  }, [graphEdges, setEdges]);

  useEffect(() => {
    if (!focusTarget) {
      return;
    }

    const targetNode = nodes.find((node) => node.id === focusTarget.nodeId);
    if (!targetNode) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const shell = graphShellRef.current;
      if (!shell) {
        return;
      }

      const shellRect = shell.getBoundingClientRect();
      const width = targetNode.measured?.width ?? targetNode.width ?? 220;
      const height = targetNode.measured?.height ?? targetNode.height ?? 140;
      const zoom = Math.max(
        0.35,
        Math.min(viewportZoom, (shellRect.width - 72) / width, (shellRect.height - 120) / height, 1),
      );
      const x = shellRect.width / 2 - (targetNode.position.x + width / 2) * zoom;
      const y = shellRect.height / 2 - (targetNode.position.y + height / 2) * zoom;

      void flowInstanceRef.current?.setViewport({ x, y, zoom }, { duration: 220 });
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [focusTarget, nodes, viewportZoom]);

  useEffect(() => {
    setSelectedColumn(null);
    setSelectedNodeCommentTargetId(null);
    setActiveCommentTargetId(null);
    setDismissedCommentTargetIds(new Set());
    setHiddenColumnNodeIds(new Set());
    setCollapsedGroupRootIds(new Set());
    setExpandedPassthroughNodeIds(new Set());
  }, [lineage]);

  return (
    <div className="graph-shell" data-testid="lineage-graph" ref={graphShellRef}>
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
        <label className="graph-callout-toggle">
          <input type="checkbox" checked={showUnusedColumns} onChange={(event) => setShowUnusedColumns(event.target.checked)} />
          Unused columns
        </label>
        <button className="graph-zoom-indicator" type="button" aria-label="Reset zoom to 100%" data-testid="graph-zoom" onClick={resetZoom}>
          <RotateCcw size={14} />
          {Math.round(viewportZoom * 100)}%
        </button>
      </div>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          defaultViewport={defaultViewport}
          onInit={(instance) => {
            flowInstanceRef.current = instance;
            setViewportZoom(1);
          }}
          onMove={(_, viewport) => setViewportZoom(viewport.zoom)}
          nodesDraggable
          nodesConnectable={false}
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

export function LineageInspector({ onFocusNode, selection }: { onFocusNode?: (nodeId: string) => void; selection: InspectorSelection }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyCteSql = async () => {
    const sql = selection?.kind === 'node' ? selection.node.cteExecutableSql : undefined;
    if (!sql) {
      return;
    }

    try {
      await navigator.clipboard.writeText(sql);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      setCopyState('failed');
      window.setTimeout(() => setCopyState('idle'), 2200);
    }
  };

  return (
    <div className="lineage-inspector" data-testid="lineage-inspector">
      <div className="lineage-inspector-header">
        <div>
          <div className="lineage-inspector-kicker">Inspector</div>
          <h2>{selection ? (selection.kind === 'column' ? selection.selected.column.name : selection.node.label) : 'No selection'}</h2>
        </div>
      </div>
      {selection ? (
        selection.kind === 'column' ? (
          <ColumnInspector onFocusNode={onFocusNode} selection={selection} />
        ) : (
          <NodeInspector copyState={copyState} node={selection.node} onCopySql={() => void copyCteSql()} />
        )
      ) : (
        <div className="lineage-inspector-empty">Select a column or node title to inspect lineage details.</div>
      )}
    </div>
  );
}

function ColumnInspector({ onFocusNode, selection }: { onFocusNode?: (nodeId: string) => void; selection: Extract<InspectorSelection, { kind: 'column' }> }) {
  return (
    <div className="lineage-inspector-body">
      <InspectorColumnCard item={selection.selected} onFocusNode={onFocusNode} title="Selected" />
      {selection.selected.column.usage ? <InspectorTextSection title="Usage" values={[formatInspectorUsage(selection.selected.column)]} /> : null}
      <InspectorColumnList emptyText="No unresolved source columns." items={selection.sources} onFocusNode={onFocusNode} title="Sources" />
      <InspectorUpstreamGroups groups={selection.upstreamGroups} onFocusNode={onFocusNode} />
      <InspectorColumnList emptyText="No downstream columns." items={selection.downstream} onFocusNode={onFocusNode} title="Downstream" />
    </div>
  );
}

function NodeInspector({
  copyState,
  node,
  onCopySql,
}: {
  copyState: 'idle' | 'copied' | 'failed';
  node: LineageNode;
  onCopySql: () => void;
}) {
  return (
    <div className="lineage-inspector-body">
      <section className="lineage-inspector-section">
        <div className="lineage-inspector-node-line">
          <span className={`lineage-inspector-type lineage-inspector-type-${node.type}`}>{node.type}</span>
          <strong>{node.columns.length}</strong>
          <span>columns</span>
        </div>
      </section>
      {node.comments?.length ? <InspectorTextSection title="Comments" values={node.comments} /> : null}
      {node.cteExecutableSql ? (
        <section className="lineage-inspector-section">
          <div className="lineage-inspector-actions">
            <a className="lineage-open-link nodrag" href={buildViewerSqlUrl(node.cteExecutableSql)} target="_blank" rel="noreferrer">
              <ExternalLink size={12} aria-hidden="true" />
              Open in viewer
            </a>
            <button className="lineage-copy-button nodrag" type="button" onClick={onCopySql}>
              <Copy size={12} aria-hidden="true" />
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy SQL'}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function InspectorColumnList({
  emptyText,
  items,
  onFocusNode,
  title,
}: {
  emptyText: string;
  items: InspectorColumnItem[];
  onFocusNode?: (nodeId: string) => void;
  title: string;
}) {
  return (
    <section className="lineage-inspector-section">
      <h3>
        {title} <span>{items.length}</span>
      </h3>
      {items.length > 0 ? (
        <div className="lineage-inspector-column-list">
          {items.map((item) => (
            <InspectorColumnCard item={item} key={`${item.node.id}:${item.column.id}`} onFocusNode={onFocusNode} />
          ))}
        </div>
      ) : (
        <div className="lineage-inspector-muted">{emptyText}</div>
      )}
    </section>
  );
}

function InspectorUpstreamGroups({ groups, onFocusNode }: { groups: InspectorColumnGroup[]; onFocusNode?: (nodeId: string) => void }) {
  return (
    <>
      {groups.length > 0 ? (
        groups.map((group, index) => (
          <InspectorColumnList
            emptyText="No upstream columns."
            items={group.items}
            key={`${group.alias ?? 'direct'}:${index}`}
            onFocusNode={onFocusNode}
            title={group.alias ? `Upstream ${group.alias}` : 'Upstream'}
          />
        ))
      ) : (
        <InspectorColumnList emptyText="No upstream columns." items={[]} title="Upstream" />
      )}
    </>
  );
}

function InspectorColumnCard({ item, onFocusNode, title }: { item: InspectorColumnItem; onFocusNode?: (nodeId: string) => void; title?: string }) {
  const expressionSql = item.column.expressionSql && !isSimpleColumnReference(item.column.expressionSql) ? item.column.expressionSql : undefined;
  const focusNode = () => onFocusNode?.(item.node.id);
  return (
    <div className="lineage-inspector-column-card">
      {title ? <div className="lineage-inspector-card-title">{title}</div> : null}
      <button className="lineage-inspector-column-name lineage-inspector-focus-button" type="button" onClick={focusNode}>
        {item.column.name}
      </button>
      <div className="lineage-inspector-column-meta">
        <span className={`lineage-inspector-type lineage-inspector-type-${item.node.type}`}>{item.node.type}</span>
        <button className="lineage-inspector-node-link lineage-inspector-focus-button" type="button" onClick={focusNode}>
          {item.node.label}
        </button>
      </div>
      {item.column.comments?.length ? <div className="lineage-inspector-card-note">{item.column.comments.join(' ')}</div> : null}
      {expressionSql ? <code className="lineage-inspector-inline-code">{expressionSql}</code> : null}
    </div>
  );
}

function InspectorTextSection({ title, values }: { title: string; values: string[] }) {
  return (
    <section className="lineage-inspector-section">
      <h3>{title}</h3>
      {values.map((value) => (
        <p key={value}>{value}</p>
      ))}
    </section>
  );
}

function resolveInspectorColumnSelection(
  nodes: LineageNode[],
  edges: LineageEdge[],
  selectedColumn: SelectedColumn,
): Extract<InspectorSelection, { kind: 'column' }> | null {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const selectedNode = nodesById.get(selectedColumn.nodeId);
  const selected = selectedNode?.columns.find((column) => column.id === selectedColumn.columnId);
  if (!selectedNode || !selected) {
    return null;
  }

  const downstreamByColumnKey = buildDownstreamColumnIndex(nodes);
  const edgeAliasByNodePair = buildEdgeAliasIndex(edges);
  const upstream = collectUpstreamColumns(nodesById, selectedNode.id, selected.name);
  const upstreamGroups = collectUpstreamColumnGroups(nodesById, edgeAliasByNodePair, selectedNode.id, selected.name);
  const downstream = collectDownstreamColumns(nodesById, downstreamByColumnKey, selectedNode.id, selected.name);
  const sources = upstream.filter((item) => (item.column.upstream ?? []).length === 0);
  return {
    kind: 'column',
    selected: { column: selected, node: selectedNode },
    sources: dedupeInspectorColumns(sources),
    upstream: dedupeInspectorColumns(upstream),
    upstreamGroups,
    downstream: dedupeInspectorColumns(downstream),
  };
}

function buildEdgeAliasIndex(edges: LineageEdge[]) {
  const aliasByNodePair = new Map<string, string | undefined>();
  for (const edge of edges) {
    if (edge.type !== 'dataFlow') {
      continue;
    }
    aliasByNodePair.set(edgeKey(edge.source, edge.target), edge.sourceAlias);
  }
  return aliasByNodePair;
}

function buildDownstreamColumnIndex(nodes: LineageNode[]) {
  const downstreamByColumnKey = new Map<string, Array<{ columnName: string; nodeId: string }>>();
  for (const node of nodes) {
    for (const column of node.columns) {
      for (const upstream of column.upstream ?? []) {
        const key = columnKey(upstream.nodeId, upstream.columnName);
        downstreamByColumnKey.set(key, [...(downstreamByColumnKey.get(key) ?? []), { columnName: column.name, nodeId: node.id }]);
      }
    }
  }
  return downstreamByColumnKey;
}

function collectUpstreamColumns(nodesById: Map<string, LineageNode>, nodeId: string, columnName: string) {
  const result: InspectorColumnItem[] = [];
  const visited = new Set<string>();

  const visit = (currentNodeId: string, currentColumnName: string) => {
    const node = nodesById.get(currentNodeId);
    const column = node?.columns.find((item) => item.name === currentColumnName);
    if (!node || !column || visited.has(column.id)) {
      return;
    }

    visited.add(column.id);
    for (const ref of column.upstream ?? []) {
      const upstreamNode = nodesById.get(ref.nodeId);
      const upstreamColumn = upstreamNode?.columns.find((item) => item.name === ref.columnName);
      if (!upstreamNode || !upstreamColumn) {
        continue;
      }
      result.push({ column: upstreamColumn, node: upstreamNode });
      visit(ref.nodeId, ref.columnName);
    }
  };

  visit(nodeId, columnName);
  return result;
}

function collectUpstreamColumnGroups(
  nodesById: Map<string, LineageNode>,
  edgeAliasByNodePair: Map<string, string | undefined>,
  nodeId: string,
  columnName: string,
) {
  const groups: InspectorColumnGroup[] = [];
  const visited = new Set<string>();

  const visit = (currentNodeId: string, currentColumnName: string) => {
    const node = nodesById.get(currentNodeId);
    const column = node?.columns.find((item) => item.name === currentColumnName);
    if (!node || !column || visited.has(column.id)) {
      return;
    }

    visited.add(column.id);
    const refs = column.upstream ?? [];
    const groupItemsByAlias = new Map<string, InspectorColumnItem[]>();
    const aliasByKey = new Map<string, string | undefined>();

    for (const ref of refs) {
      const upstreamNode = nodesById.get(ref.nodeId);
      const upstreamColumn = upstreamNode?.columns.find((item) => item.name === ref.columnName);
      if (!upstreamNode || !upstreamColumn) {
        continue;
      }

      const alias = edgeAliasByNodePair.get(edgeKey(ref.nodeId, currentNodeId));
      const key = alias ?? '';
      aliasByKey.set(key, alias);
      groupItemsByAlias.set(key, [...(groupItemsByAlias.get(key) ?? []), { column: upstreamColumn, node: upstreamNode }]);
    }

    for (const [key, items] of groupItemsByAlias) {
      const dedupedItems = dedupeInspectorColumns(items);
      if (dedupedItems.length > 0) {
        groups.push({ alias: aliasByKey.get(key), items: dedupedItems });
      }
    }

    for (const ref of refs) {
      visit(ref.nodeId, ref.columnName);
    }
  };

  visit(nodeId, columnName);
  return groups;
}

function collectDownstreamColumns(
  nodesById: Map<string, LineageNode>,
  downstreamByColumnKey: Map<string, Array<{ columnName: string; nodeId: string }>>,
  nodeId: string,
  columnName: string,
) {
  const result: InspectorColumnItem[] = [];
  const visited = new Set<string>();

  const visit = (currentNodeId: string, currentColumnName: string) => {
    const columnId = `${currentNodeId}:${currentColumnName}`;
    if (visited.has(columnId)) {
      return;
    }

    visited.add(columnId);
    for (const ref of downstreamByColumnKey.get(columnKey(currentNodeId, currentColumnName)) ?? []) {
      const downstreamNode = nodesById.get(ref.nodeId);
      const downstreamColumn = downstreamNode?.columns.find((item) => item.name === ref.columnName);
      if (!downstreamNode || !downstreamColumn) {
        continue;
      }
      result.push({ column: downstreamColumn, node: downstreamNode });
      visit(ref.nodeId, ref.columnName);
    }
  };

  visit(nodeId, columnName);
  return result;
}

function dedupeInspectorColumns(items: InspectorColumnItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.node.id}:${item.column.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatInspectorUsage(column: LineageColumn) {
  if (column.usage?.role === 'unused') {
    return 'Unused';
  }

  const reasons = column.usage?.reasons?.map(formatUsageReason) ?? ['Condition'];
  return `Used by: ${[...new Set(reasons)].join(', ')}`;
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

function formatUsageReason(reason: string): string {
  if (reason === 'groupBy') return 'GROUP BY';
  if (reason === 'orderBy') return 'ORDER BY';
  return reason.toUpperCase();
}

function buildViewerSqlUrl(sql: string) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = new URLSearchParams({ sql }).toString();
  return url.toString();
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
