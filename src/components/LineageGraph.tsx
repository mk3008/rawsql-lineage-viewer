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
import { Copy, ExternalLink, Eye, EyeOff, Pencil, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { GraphEdge, GraphNode } from '../domain/graph';
import type { LineageCaseRule, LineageColumn, LineageColumnRef, LineageExpressionTree, LineageModel, LineageNode } from '../domain/lineage';
import { buildGraphModel, type GraphFlowDirection } from '../graph/buildGraphModel';
import { collectCollapsibleUpstreamGroups, collapseLineageGroups } from '../graph/collapseGroups';
import { isSimpleColumnReference } from '../lineage/columnDisplay';
import { LineageNodeCard } from './LineageNodeCard';
import { SqlCodeMirror } from './SqlCodeMirror';

const nodeTypes = {
  lineageNode: LineageNodeCard,
};

const edgeTypes = {
  lineageDataFlow: LineageDataFlowEdge,
};

const defaultViewport = { x: 16, y: 72, zoom: 1 };
const selectionHistoryStateKey = 'rawsqlLineageViewerSelection';

interface SelectedColumn {
  columnId: string;
  columnName: string;
  nodeId: string;
}

export interface GraphHighlightColumnTarget extends SelectedColumn {
  upstreamRefs?: LineageColumnRef[];
}

export type GraphHighlightTarget =
  | { column: GraphHighlightColumnTarget; kind: 'column' }
  | { columns: GraphHighlightColumnTarget[]; kind: 'columns' }
  | null;

type GraphSelectionSnapshot =
  | { kind: 'none' }
  | { kind: 'node'; nodeId: string }
  | { columnId: string; columnName: string; kind: 'column'; nodeId: string };

export interface CaseRuleSelection {
  columnId: string;
  nodeId: string;
  ruleId: string;
}

export type InspectorSelection =
  | {
      kind: 'column';
      selected: InspectorColumnItem;
      sources: InspectorColumnItem[];
      upstream: InspectorColumnItem[];
      upstreamTree: InspectorColumnTreeNode[];
      downstream: InspectorColumnItem[];
      downstreamTree: InspectorColumnTreeNode[];
      expressionExpanded: boolean;
      hasExpressionBreakdown: boolean;
    }
  | {
      kind: 'node';
      node: LineageNode;
    }
  | null;

export interface InspectorColumnItem {
  column: LineageColumn;
  node: LineageNode;
}

interface InspectorColumnGroup {
  alias?: string;
  items: InspectorColumnItem[];
}

type SelectInspectorCard = (cardId: string, nodeId?: string, target?: GraphHighlightTarget) => void;

type InspectorColumnTreeNode = InspectorColumnTreeColumnNode | InspectorColumnTreeExpressionNode | InspectorColumnTreeRuleNode;

interface InspectorColumnTreeColumnNode {
  children: InspectorColumnTreeNode[];
  kind: 'column';
  item: InspectorColumnItem;
}

interface InspectorColumnTreeRuleNode {
  children: InspectorColumnTreeNode[];
  item: InspectorColumnItem;
  kind: 'rule';
  ownerNode: LineageNode;
  rule: LineageCaseRule;
}

interface InspectorColumnTreeExpressionNode {
  children: InspectorColumnTreeNode[];
  expression: LineageExpressionTree;
  kind: 'expression';
  ownerNode: LineageNode;
}

export function LineageGraph({
  autoInspectOutputNonce,
  caseRuleSelection,
  expandedExpressionColumnIds,
  focusTarget,
  flowDirection,
  highlightTargetRequest,
  lineage,
  onInspectorSelectionChange,
  outputTitle,
}: {
  autoInspectOutputNonce?: number;
  caseRuleSelection?: CaseRuleSelection | null;
  expandedExpressionColumnIds?: Set<string>;
  focusTarget?: { nonce: number; nodeId: string } | null;
  flowDirection: GraphFlowDirection;
  highlightTargetRequest?: { nonce: number; target: GraphHighlightTarget } | null;
  lineage: LineageModel;
  onInspectorSelectionChange?: (selection: InspectorSelection) => void;
  outputTitle?: string;
}) {
  const previousLineageRef = useRef(lineage);
  const previousFlowDirectionRef = useRef(flowDirection);
  const graphShellRef = useRef<HTMLDivElement | null>(null);
  const lastHandledAutoInspectOutputNonceRef = useRef<number | null>(null);
  const lastHandledFocusNonceRef = useRef<number | null>(null);
  const lastHandledHighlightNonceRef = useRef<number | null>(null);
  const lastCommittedSelectionRef = useRef<GraphSelectionSnapshot>({ kind: 'none' });
  const nodePositionsRef = useRef(new Map<string, { x: number; y: number }>());
  const flowInstanceRef = useRef<ReactFlowInstance<GraphNode, GraphEdge> | null>(null);
  const [collapsedGroupRootIds, setCollapsedGroupRootIds] = useState<Set<string>>(() => new Set());
  const collapsibleGroups = useMemo(() => collectCollapsibleUpstreamGroups(lineage), [lineage]);
  const collapsedLineage = useMemo(() => collapseLineageGroups(lineage, collapsedGroupRootIds), [collapsedGroupRootIds, lineage]);
  const viewLineage = collapsedLineage.lineage;
  const displayLineage = useMemo(() => applyOutputTitle(viewLineage, outputTitle), [outputTitle, viewLineage]);
  const displayLineageRef = useRef(displayLineage);
  const graph = useMemo(() => buildGraphModel(displayLineage, flowDirection), [displayLineage, flowDirection]);
  const hideableColumnNodeIds = useMemo(() => new Set(displayLineage.nodes.filter((node) => canHideColumns(node, flowDirection)).map((node) => node.id)), [displayLineage.nodes, flowDirection]);
  const [hiddenColumnNodeIds, setHiddenColumnNodeIds] = useState<Set<string>>(() => createDefaultHiddenColumnNodeIds(displayLineage.nodes, flowDirection));
  const [selectedColumn, setSelectedColumn] = useState<SelectedColumn | null>(null);
  const [highlightTarget, setHighlightTarget] = useState<GraphHighlightTarget>(null);
  const [selectedNodeCommentTargetId, setSelectedNodeCommentTargetId] = useState<string | null>(null);
  const [activeCommentTargetId, setActiveCommentTargetId] = useState<string | null>(null);
  const [dismissedCommentTargetIds, setDismissedCommentTargetIds] = useState<Set<string>>(() => new Set());
  const showColumnCallouts = false;
  const showHeaderCallouts = false;
  const [showUnusedColumns, setShowUnusedColumns] = useState(true);
  const [expandedPassthroughNodeIds, setExpandedPassthroughNodeIds] = useState<Set<string>>(() => new Set());
  const [viewportZoom, setViewportZoom] = useState(1);
  const resetZoom = useCallback(() => {
    void flowInstanceRef.current?.setViewport(defaultViewport, { duration: 120 });
    setViewportZoom(1);
  }, []);
  const allColumnsHidden = hideableColumnNodeIds.size > 0 && [...hideableColumnNodeIds].every((nodeId) => hiddenColumnNodeIds.has(nodeId));
  const toggleColumns = useCallback((nodeId: string) => {
    if (!hideableColumnNodeIds.has(nodeId)) {
      return;
    }

    setHiddenColumnNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, [hideableColumnNodeIds]);
  const toggleAllColumns = useCallback(() => {
    setHiddenColumnNodeIds((current) => {
      if (hideableColumnNodeIds.size > 0 && [...hideableColumnNodeIds].every((nodeId) => current.has(nodeId))) {
        return new Set();
      }

      return new Set(hideableColumnNodeIds);
    });
  }, [hideableColumnNodeIds]);
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
  const commitSelectionHistory = useCallback((selection: GraphSelectionSnapshot, mode: 'push' | 'replace' = 'push') => {
    if (typeof window === 'undefined') {
      return;
    }
    if (mode === 'push' && isSameGraphSelectionSnapshot(lastCommittedSelectionRef.current, selection)) {
      return;
    }

    const currentState = isRecord(window.history.state) ? window.history.state : {};
    const nextState = {
      ...currentState,
      [selectionHistoryStateKey]: selection,
    };
    if (mode === 'replace') {
      window.history.replaceState(nextState, '', window.location.href);
    } else {
      window.history.pushState(nextState, '', window.location.href);
    }
    lastCommittedSelectionRef.current = selection;
  }, []);
  const applySelectionSnapshot = useCallback((selection: GraphSelectionSnapshot) => {
    const currentLineage = displayLineageRef.current;
    setDismissedCommentTargetIds(new Set());

    if (selection.kind === 'node') {
      const node = currentLineage.nodes.find((item) => item.id === selection.nodeId);
      if (node) {
        const targetId = nodeCommentTargetId(node.id);
        setSelectedColumn(null);
        setHighlightTarget(null);
        setSelectedNodeCommentTargetId(targetId);
        setActiveCommentTargetId(targetId);
        return;
      }
    }

    if (selection.kind === 'column') {
      const node = currentLineage.nodes.find((item) => item.id === selection.nodeId);
      const column = node?.columns.find((item) => item.id === selection.columnId);
      if (node && column) {
        const targetId = columnCommentTargetId(column.id);
        setSelectedNodeCommentTargetId(null);
        const nextColumn = {
          columnId: column.id,
          columnName: column.name,
          nodeId: node.id,
        };
        setSelectedColumn(nextColumn);
        setHighlightTarget({ column: nextColumn, kind: 'column' });
        setActiveCommentTargetId(targetId);
        return;
      }
    }

    setSelectedColumn(null);
    setHighlightTarget(null);
    setSelectedNodeCommentTargetId(null);
    setActiveCommentTargetId(null);
  }, []);
  const selectNode = useCallback((nodeId: string) => {
    const targetId = nodeCommentTargetId(nodeId);
    const nextSelection: GraphSelectionSnapshot = selectedNodeCommentTargetId === targetId ? { kind: 'none' } : { kind: 'node', nodeId };
    commitSelectionHistory(nextSelection);
    applySelectionSnapshot(nextSelection);
  }, [applySelectionSnapshot, commitSelectionHistory, selectedNodeCommentTargetId]);
  const inspectNode = useCallback((nodeId: string) => {
    const nextSelection: GraphSelectionSnapshot = { kind: 'node', nodeId };
    commitSelectionHistory(nextSelection);
    applySelectionSnapshot(nextSelection);
  }, [applySelectionSnapshot, commitSelectionHistory]);
  const selectColumn = useCallback((nodeId: string, column: LineageColumn) => {
    const nextSelection: GraphSelectionSnapshot =
      selectedColumn?.columnId === column.id
        ? { kind: 'none' }
        : {
            columnId: column.id,
            columnName: column.name,
            kind: 'column',
            nodeId,
          };
    commitSelectionHistory(nextSelection);
    applySelectionSnapshot(nextSelection);
  }, [applySelectionSnapshot, commitSelectionHistory, selectedColumn?.columnId]);
  const closeComment = useCallback((targetId: string) => {
    setDismissedCommentTargetIds((current) => new Set(current).add(targetId));
    setActiveCommentTargetId((current) => (current === targetId ? null : current));
  }, []);
  const focusComment = useCallback((targetId: string) => {
    setActiveCommentTargetId(targetId);
  }, []);
  const columnHighlights = useMemo(
    () => resolveHighlightTarget(displayLineage.nodes, highlightTarget),
    [displayLineage.nodes, highlightTarget],
  );
  const activeLineageRootColumnIds = useMemo(() => {
    if (!highlightTarget) {
      return new Set<string>();
    }
    if (highlightTarget.kind === 'column') {
      return new Set([highlightTarget.column.columnId]);
    }
    return new Set(highlightTarget.columns.map((column) => column.columnId));
  }, [highlightTarget]);
  const forcedVisibleColumnIds = useMemo(() => {
    const columnIds = new Set<string>();
    if (selectedColumn) {
      columnIds.add(selectedColumn.columnId);
    }
    for (const columnId of activeLineageRootColumnIds) {
      columnIds.add(columnId);
    }
    for (const columnId of columnHighlights.highlightedColumnIds) {
      columnIds.add(columnId);
    }
    for (const columnId of columnHighlights.sourceColumnIds) {
      columnIds.add(columnId);
    }
    return columnIds;
  }, [activeLineageRootColumnIds, columnHighlights.highlightedColumnIds, columnHighlights.sourceColumnIds, selectedColumn]);
  const graphSelectedColumnId = activeLineageRootColumnIds.size === 1 ? [...activeLineageRootColumnIds][0] : null;
  const selectedRuleExpressionByColumnId = useMemo(() => {
    if (!selectedColumn) {
      return undefined;
    }

    const rule = resolveSelectedCaseRule(displayLineage.nodes, selectedColumn, caseRuleSelection);
    if (!rule?.expressionSql) {
      return undefined;
    }

    return new Map([[selectedColumn.columnId, rule.expressionSql]]);
  }, [caseRuleSelection, displayLineage.nodes, selectedColumn]);
  const inspectorSelection = useMemo<InspectorSelection>(() => {
    if (selectedColumn) {
      return resolveInspectorColumnSelection(
        displayLineage.nodes,
        selectedColumn,
        expandedExpressionColumnIds ?? new Set(),
        resolveSelectedCaseRuleRefs(displayLineage.nodes, selectedColumn, caseRuleSelection),
      );
    }

    if (selectedNodeCommentTargetId) {
      const nodeId = selectedNodeCommentTargetId.replace(/^node:/, '');
      const node = displayLineage.nodes.find((item) => item.id === nodeId);
      return node ? { kind: 'node', node } : null;
    }

    return null;
  }, [caseRuleSelection, displayLineage.edges, displayLineage.nodes, expandedExpressionColumnIds, selectedColumn, selectedNodeCommentTargetId]);
  useEffect(() => {
    displayLineageRef.current = displayLineage;
  }, [displayLineage]);
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const currentSelection = readSelectionHistoryState(window.history.state);
    if (currentSelection) {
      lastCommittedSelectionRef.current = currentSelection;
      applySelectionSnapshot(currentSelection);
    } else {
      commitSelectionHistory({ kind: 'none' }, 'replace');
    }

    const handlePopState = (event: PopStateEvent) => {
      const selection = readSelectionHistoryState(event.state) ?? { kind: 'none' };
      lastCommittedSelectionRef.current = selection;
      applySelectionSnapshot(selection);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [applySelectionSnapshot, commitSelectionHistory]);
  useEffect(() => {
    onInspectorSelectionChange?.(inspectorSelection);
  }, [inspectorSelection, onInspectorSelectionChange]);
  useEffect(() => {
    if (!autoInspectOutputNonce || lastHandledAutoInspectOutputNonceRef.current === autoInspectOutputNonce) {
      return;
    }

    lastHandledAutoInspectOutputNonceRef.current = autoInspectOutputNonce;
    const outputNode = displayLineage.nodes.find((node) => node.type === 'output');
    if (outputNode) {
      inspectNode(outputNode.id);
      onInspectorSelectionChange?.({ kind: 'node', node: outputNode });
    }
  }, [autoInspectOutputNonce, displayLineage.nodes, inspectNode, onInspectorSelectionChange]);
  const selectedCommentTargetIds = useMemo(() => {
    if (selectedColumn) {
      const targetIds = new Set<string>();
      if (!showColumnCallouts) {
        return targetIds;
      }

      targetIds.add(columnCommentTargetId(selectedColumn.columnId));
      for (const columnId of columnHighlights.highlightedColumnIds) {
        targetIds.add(columnCommentTargetId(columnId));
      }
      for (const columnId of columnHighlights.sourceColumnIds) {
        targetIds.add(columnCommentTargetId(columnId));
      }
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
          canToggleColumns: hideableColumnNodeIds.has(node.id),
          canCollapseUpstream: collapsibleGroups.has(node.id),
          collapsedGroup: collapsedLineage.groups.get(node.id),
          columnsVisible: !hiddenColumnNodeIds.has(node.id),
          forcedVisibleColumnIds,
          onCollapseUpstream: collapseUpstream,
          onExpandGroup: expandGroup,
          onToggleColumns: toggleColumns,
          onNodeSelect: selectNode,
          onColumnSelect: selectColumn,
          selectedNodeId: selectedNodeCommentTargetId?.replace(/^node:/, '') ?? null,
          selectedColumnId: graphSelectedColumnId,
          selectedCommentTargetIds,
          selectedRuleExpressionByColumnId,
          activeCommentTargetId,
          viewportZoom,
          activeLineageRootColumnIds,
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
      forcedVisibleColumnIds,
      graph.nodes,
      hiddenColumnNodeIds,
      hideableColumnNodeIds,
      selectNode,
      selectColumn,
      closeComment,
      focusComment,
      activeCommentTargetId,
      activeLineageRootColumnIds,
      viewportZoom,
      graphSelectedColumnId,
      selectedColumn?.columnId,
      selectedRuleExpressionByColumnId,
      selectedCommentTargetIds,
      selectedNodeCommentTargetId,
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
          zIndex: 1000,
          style: {
            ...baseStyle,
            stroke: '#2563eb',
            strokeWidth: 2,
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
    if (lastHandledFocusNonceRef.current === focusTarget.nonce) {
      return;
    }

    const targetNode = nodes.find((node) => node.id === focusTarget.nodeId);
    if (!targetNode) {
      return;
    }
    lastHandledFocusNonceRef.current = focusTarget.nonce;

    const timeoutId = window.setTimeout(() => {
      const shell = graphShellRef.current;
      if (!shell) {
        return;
      }

      const shellRect = shell.getBoundingClientRect();
      const width = targetNode.measured?.width ?? targetNode.width ?? 220;
      const height = targetNode.measured?.height ?? targetNode.height ?? 140;
      const zoom = viewportZoom;
      const x = shellRect.width / 2 - (targetNode.position.x + width / 2) * zoom;
      const y = shellRect.height / 2 - (targetNode.position.y + height / 2) * zoom;

      void flowInstanceRef.current?.setViewport({ x, y, zoom }, { duration: 220 });
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [focusTarget?.nodeId, focusTarget?.nonce]);

  useEffect(() => {
    if (!highlightTargetRequest) {
      return;
    }
    if (lastHandledHighlightNonceRef.current === highlightTargetRequest.nonce) {
      return;
    }

    lastHandledHighlightNonceRef.current = highlightTargetRequest.nonce;
    setHighlightTarget(highlightTargetRequest.target);
  }, [highlightTargetRequest?.nonce, highlightTargetRequest?.target]);

  useEffect(() => {
    setSelectedColumn(null);
    setHighlightTarget(null);
    setSelectedNodeCommentTargetId(null);
    setActiveCommentTargetId(null);
    setDismissedCommentTargetIds(new Set());
    setHiddenColumnNodeIds(createDefaultHiddenColumnNodeIds(lineage.nodes, flowDirection));
    setCollapsedGroupRootIds(new Set());
    setExpandedPassthroughNodeIds(new Set());
    commitSelectionHistory({ kind: 'none' });
  }, [commitSelectionHistory, flowDirection, lineage]);

  return (
    <div className="graph-shell" data-testid="lineage-graph" ref={graphShellRef}>
      <div className="graph-display-controls nodrag" aria-label="Graph display options">
        <button className="graph-column-toggle" type="button" onClick={toggleAllColumns}>
          {allColumnsHidden ? <Eye size={15} /> : <EyeOff size={15} />}
          {allColumnsHidden ? 'Show all columns' : 'Hide all columns'}
        </button>
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

export function LineageInspector({
  activeCaseRule,
  expandedExpressionColumnIds,
  flowDirection,
  onClearCaseRule,
  onFocusNode,
  onHighlightTarget,
  onRenameOutputTitle,
  onToggleExpressionBreakdown,
  selection,
}: {
  activeCaseRule?: CaseRuleSelection | null;
  expandedExpressionColumnIds?: Set<string>;
  flowDirection: GraphFlowDirection;
  onClearCaseRule?: () => void;
  onFocusNode?: (nodeId: string) => void;
  onHighlightTarget?: (target: GraphHighlightTarget) => void;
  onRenameOutputTitle?: (title: string) => void;
  onToggleExpressionBreakdown?: (columnId: string) => void;
  selection: InspectorSelection;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [editingOutputTitle, setEditingOutputTitle] = useState(false);
  const [draftOutputTitle, setDraftOutputTitle] = useState('');
  const selectedNode = selection?.kind === 'node' ? selection.node : undefined;
  const canRenameOutput = selectedNode?.type === 'output' && Boolean(onRenameOutputTitle);
  const inspectorTitle = selection ? (selection.kind === 'column' ? selection.selected.column.name : selection.node.label) : 'No selection';

  useEffect(() => {
    if (!editingOutputTitle) {
      setDraftOutputTitle(selectedNode?.label ?? '');
    }
  }, [editingOutputTitle, selectedNode?.label]);

  const startEditingOutputTitle = () => {
    setDraftOutputTitle(selectedNode?.label ?? '');
    setEditingOutputTitle(true);
  };

  const cancelEditingOutputTitle = () => {
    setDraftOutputTitle(selectedNode?.label ?? '');
    setEditingOutputTitle(false);
  };

  const saveOutputTitle = () => {
    onRenameOutputTitle?.(draftOutputTitle);
    setEditingOutputTitle(false);
  };

  const copyCteSql = async () => {
    const sql = selection?.kind === 'node' ? getNodeSql(selection.node) : undefined;
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
        <div className="lineage-inspector-title-block">
          <div className="lineage-inspector-kicker">Inspector</div>
          {editingOutputTitle ? (
            <form
              className="lineage-output-title-form lineage-output-title-form-header"
              onSubmit={(event) => {
                event.preventDefault();
                saveOutputTitle();
              }}
            >
              <input
                aria-label="Output title"
                autoFocus
                className="lineage-output-title-input"
                value={draftOutputTitle}
                onChange={(event) => setDraftOutputTitle(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelEditingOutputTitle();
                    return;
                  }
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    saveOutputTitle();
                  }
                }}
              />
              <button className="lineage-copy-button" type="submit">Save title</button>
              <button className="lineage-copy-button" type="button" onClick={cancelEditingOutputTitle}>Cancel</button>
            </form>
          ) : (
            <h2>{inspectorTitle}</h2>
          )}
        </div>
        {canRenameOutput && !editingOutputTitle ? (
          <button className="lineage-copy-button lineage-output-title-edit-button" type="button" onClick={startEditingOutputTitle}>
            <Pencil size={12} aria-hidden="true" />
            Edit
          </button>
        ) : null}
      </div>
      {selection ? (
        selection.kind === 'column' ? (
          <ColumnInspector
            activeCaseRule={activeCaseRule}
            expandedExpressionColumnIds={expandedExpressionColumnIds}
            flowDirection={flowDirection}
            onClearCaseRule={onClearCaseRule}
            onFocusNode={onFocusNode}
            onHighlightTarget={onHighlightTarget}
            onToggleExpressionBreakdown={onToggleExpressionBreakdown}
            selection={selection}
          />
        ) : (
          <NodeInspector copyState={copyState} node={selection.node} onCopySql={() => void copyCteSql()} />
        )
      ) : (
        <div className="lineage-inspector-empty">Select a column or node title to inspect lineage details.</div>
      )}
    </div>
  );
}

function ColumnInspector({
  activeCaseRule,
  expandedExpressionColumnIds,
  flowDirection,
  onClearCaseRule,
  onFocusNode,
  onHighlightTarget,
  onToggleExpressionBreakdown,
  selection,
}: {
  activeCaseRule?: CaseRuleSelection | null;
  expandedExpressionColumnIds?: Set<string>;
  flowDirection: GraphFlowDirection;
  onClearCaseRule?: () => void;
  onFocusNode?: (nodeId: string) => void;
  onHighlightTarget?: (target: GraphHighlightTarget) => void;
  onToggleExpressionBreakdown?: (columnId: string) => void;
  selection: Extract<InspectorSelection, { kind: 'column' }>;
}) {
  const defaultTab = flowDirection === 'downstream' ? 'downstream' : 'upstream';
  const [activeTab, setActiveTab] = useState<'upstream' | 'downstream'>(defaultTab);
  const [activeInspectorCardId, setActiveInspectorCardId] = useState<string | null>(null);
  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab, selection.selected.column.id, selection.selected.node.id]);
  useEffect(() => {
    setActiveInspectorCardId(null);
  }, [selection.selected.column.id, selection.selected.node.id]);
  const selectWholeColumn = () => {
    setActiveInspectorCardId(null);
    onFocusNode?.(selection.selected.node.id);
    onHighlightTarget?.({ column: inspectorItemToHighlightColumn(selection.selected), kind: 'column' });
    onClearCaseRule?.();
  };
  const toggleExpressionBreakdown = () => {
    setActiveInspectorCardId(null);
    onClearCaseRule?.();
    onToggleExpressionBreakdown?.(selection.selected.column.id);
  };
  const selectInspectorCard = (cardId: string, nodeId?: string, target?: GraphHighlightTarget) => {
    setActiveInspectorCardId(cardId);
    if (nodeId) {
      onFocusNode?.(nodeId);
    }
    if (target !== undefined) {
      onHighlightTarget?.(target);
    }
  };

  return (
    <div className="lineage-inspector-body">
      <InspectorSourceGroups
        activeInspectorCardId={activeInspectorCardId}
        items={selection.sources}
        onFocusNode={onFocusNode}
        onSelectInspectorCard={selectInspectorCard}
      />
      <section className="lineage-inspector-section">
        <div className="lineage-inspector-tabs" role="tablist" aria-label="Lineage direction">
          <button
            aria-selected={activeTab === 'upstream'}
            className={activeTab === 'upstream' ? 'lineage-inspector-tab-active' : ''}
            role="tab"
            type="button"
            onClick={() => setActiveTab('upstream')}
          >
            Upstream <span>{selection.upstream.length}</span>
          </button>
          <button
            aria-selected={activeTab === 'downstream'}
            className={activeTab === 'downstream' ? 'lineage-inspector-tab-active' : ''}
            role="tab"
            type="button"
            onClick={() => setActiveTab('downstream')}
          >
            Downstream <span>{selection.downstream.length}</span>
          </button>
        </div>
        <div className="lineage-inspector-tab-panel" role="tabpanel">
          {activeTab === 'upstream' ? (
            <InspectorUpstreamTree
              activeInspectorCardId={activeInspectorCardId}
              expandedExpressionColumnIds={expandedExpressionColumnIds}
              onFocusNode={onFocusNode}
              onToggleColumnExpressionBreakdown={onToggleExpressionBreakdown}
              onSelectRoot={selectWholeColumn}
              onSelectInspectorCard={selectInspectorCard}
              onToggleExpressionBreakdown={toggleExpressionBreakdown}
              expressionExpanded={selection.expressionExpanded}
              hasExpressionBreakdown={selection.hasExpressionBreakdown}
              rootActive={!activeCaseRule && activeInspectorCardId === null}
              rootItem={selection.selected}
              tree={selection.upstreamTree}
            />
          ) : (
            <InspectorColumnTree
              activeInspectorCardId={activeInspectorCardId}
              expandedExpressionColumnIds={expandedExpressionColumnIds}
              emptyText="No downstream columns."
              onFocusNode={onFocusNode}
              onToggleColumnExpressionBreakdown={onToggleExpressionBreakdown}
              onSelectRoot={selectWholeColumn}
              onSelectInspectorCard={selectInspectorCard}
              onToggleExpressionBreakdown={toggleExpressionBreakdown}
              expressionExpanded={selection.expressionExpanded}
              hasExpressionBreakdown={selection.hasExpressionBreakdown}
              rootActive={!activeCaseRule && activeInspectorCardId === null}
              rootItem={selection.selected}
              title="Downstream"
              tree={selection.downstreamTree}
            />
          )}
        </div>
      </section>
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
    <div className="lineage-inspector-body lineage-inspector-node-body">
      <section className="lineage-inspector-section">
        <div className="lineage-inspector-node-line">
          <InspectorTypeBadge node={node} />
          <strong>{node.columns.length}</strong>
          <span>columns</span>
        </div>
      </section>
      {node.comments?.length ? <InspectorTextSection title="Comments" values={node.comments} /> : null}
      {getNodeSql(node) ? (
        <section className="lineage-inspector-section lineage-inspector-sql-section">
          <div className="lineage-inspector-actions">
            <a className="lineage-open-link nodrag" href={buildViewerSqlUrl(getNodeSql(node) ?? '')} target="_blank" rel="noreferrer">
              <ExternalLink size={12} aria-hidden="true" />
              Open in viewer
            </a>
            <button className="lineage-copy-button nodrag" type="button" onClick={onCopySql}>
              <Copy size={12} aria-hidden="true" />
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy SQL'}
            </button>
          </div>
          <SqlCodeMirror className="lineage-inspector-code" value={getNodeSql(node) ?? ''} />
        </section>
      ) : null}
    </div>
  );
}

function InspectorSourceGroups({
  activeInspectorCardId,
  items,
  onFocusNode,
  onSelectInspectorCard,
}: {
  activeInspectorCardId?: string | null;
  items: InspectorColumnItem[];
  onFocusNode?: (nodeId: string) => void;
  onSelectInspectorCard?: SelectInspectorCard;
}) {
  const groups = groupInspectorItemsByNode(items);
  return (
    <section className="lineage-inspector-section">
      <h3>
        Sources <span>{items.length}</span>
      </h3>
      {groups.length > 0 ? (
        <div className="lineage-inspector-source-list">
          {groups.map((group) => (
            <InspectorSourceGroup
              activeInspectorCardId={activeInspectorCardId}
              group={group}
              key={group.items[0]?.node.id ?? 'source'}
              onFocusNode={onFocusNode}
              onSelectInspectorCard={onSelectInspectorCard}
            />
          ))}
        </div>
      ) : (
        <div className="lineage-inspector-muted">No unresolved source columns.</div>
      )}
    </section>
  );
}

function InspectorSourceGroup({
  activeInspectorCardId,
  group,
  onFocusNode,
  onSelectInspectorCard,
}: {
  activeInspectorCardId?: string | null;
  group: InspectorColumnGroup;
  onFocusNode?: (nodeId: string) => void;
  onSelectInspectorCard?: SelectInspectorCard;
}) {
  const node = group.items[0]?.node;
  if (!node) {
    return null;
  }
  const focusNode = () => onFocusNode?.(node.id);
  return (
    <div className="lineage-inspector-source-group">
      <div className="lineage-inspector-source-heading">
        <InspectorTypeBadge node={node} />
        <button className="lineage-inspector-node-link lineage-inspector-focus-button" type="button" onClick={focusNode}>
          {node.label}
        </button>
      </div>
      <div className="lineage-inspector-source-columns">
        {group.items.map((item, index) => {
          const expressionSql =
            item.column.expressionSql && !isSimpleColumnReference(item.column.expressionSql) ? item.column.expressionSql : undefined;
          const cardId = inspectorSourceItemKey(item, index);
          const active = activeInspectorCardId === cardId;
          return (
            <div
              className={`lineage-inspector-source-column lineage-inspector-source-column-selectable ${active ? 'lineage-inspector-source-column-active' : ''}`}
              key={item.column.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelectInspectorCard?.(cardId, item.node.id, { column: inspectorItemToHighlightColumn(item), kind: 'column' })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectInspectorCard?.(cardId, item.node.id, { column: inspectorItemToHighlightColumn(item), kind: 'column' });
                }
              }}
            >
              <span className="lineage-inspector-column-name">{item.column.name}</span>
              {item.column.comments?.length ? <div className="lineage-inspector-card-note">{item.column.comments.join(' ')}</div> : null}
              {expressionSql ? <SqlCodeMirror className="lineage-inspector-inline-code" value={expressionSql} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InspectorUpstreamTree({
  activeInspectorCardId,
  expandedExpressionColumnIds,
  expressionExpanded,
  hasExpressionBreakdown,
  onFocusNode,
  onToggleColumnExpressionBreakdown,
  onSelectRoot,
  onSelectInspectorCard,
  onToggleExpressionBreakdown,
  rootActive,
  rootItem,
  tree,
}: {
  activeInspectorCardId?: string | null;
  expandedExpressionColumnIds?: Set<string>;
  expressionExpanded?: boolean;
  hasExpressionBreakdown?: boolean;
  onFocusNode?: (nodeId: string) => void;
  onToggleColumnExpressionBreakdown?: (columnId: string) => void;
  onSelectRoot: () => void;
  onSelectInspectorCard?: SelectInspectorCard;
  onToggleExpressionBreakdown?: () => void;
  rootActive: boolean;
  rootItem: InspectorColumnItem;
  tree: InspectorColumnTreeNode[];
}) {
  return (
    <section className="lineage-inspector-section">
      <h3>
        Upstream <span>{tree.length}</span>
      </h3>
      <div className="lineage-inspector-tree">
        <div className="lineage-inspector-tree-node">
          <InspectorColumnCard
            active={rootActive}
            item={rootItem}
            onClearCaseRule={onSelectRoot}
            onFocusNode={onFocusNode}
            onToggleExpressionBreakdown={onToggleExpressionBreakdown}
            expressionExpanded={expressionExpanded}
            hasExpressionBreakdown={hasExpressionBreakdown}
            root
            selectable
            showSimpleExpression
            showUsage
          />
          {tree.length > 0 ? (
            <InspectorColumnTreeNodes
              activeInspectorCardId={activeInspectorCardId}
              depth={1}
              expandedExpressionColumnIds={expandedExpressionColumnIds}
              nodes={tree}
              onFocusNode={onFocusNode}
              onSelectInspectorCard={onSelectInspectorCard}
              onToggleExpressionBreakdown={onToggleColumnExpressionBreakdown}
              pathKey="root"
              rootItem={rootItem}
            />
          ) : (
            <div className="lineage-inspector-muted">No upstream columns.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function InspectorColumnTree({
  activeInspectorCardId,
  emptyText,
  expandedExpressionColumnIds,
  expressionExpanded,
  hasExpressionBreakdown,
  onFocusNode,
  onToggleColumnExpressionBreakdown,
  onSelectRoot,
  onSelectInspectorCard,
  onToggleExpressionBreakdown,
  rootActive,
  rootItem,
  title,
  tree,
}: {
  activeInspectorCardId?: string | null;
  emptyText: string;
  expandedExpressionColumnIds?: Set<string>;
  expressionExpanded?: boolean;
  hasExpressionBreakdown?: boolean;
  onFocusNode?: (nodeId: string) => void;
  onToggleColumnExpressionBreakdown?: (columnId: string) => void;
  onSelectRoot: () => void;
  onSelectInspectorCard?: SelectInspectorCard;
  onToggleExpressionBreakdown?: () => void;
  rootActive: boolean;
  rootItem: InspectorColumnItem;
  title: string;
  tree: InspectorColumnTreeNode[];
}) {
  return (
    <section className="lineage-inspector-section">
      <h3>
        {title} <span>{tree.length}</span>
      </h3>
      <div className="lineage-inspector-tree">
        <div className="lineage-inspector-tree-node">
          <InspectorColumnCard
            active={rootActive}
            item={rootItem}
            onClearCaseRule={onSelectRoot}
            onFocusNode={onFocusNode}
            onToggleExpressionBreakdown={onToggleExpressionBreakdown}
            expressionExpanded={expressionExpanded}
            hasExpressionBreakdown={hasExpressionBreakdown}
            root
            selectable
            showSimpleExpression
            showUsage
          />
          {tree.length > 0 ? (
            <InspectorColumnTreeNodes
              activeInspectorCardId={activeInspectorCardId}
              depth={1}
              expandedExpressionColumnIds={expandedExpressionColumnIds}
              nodes={tree}
              onFocusNode={onFocusNode}
              onSelectInspectorCard={onSelectInspectorCard}
              onToggleExpressionBreakdown={onToggleColumnExpressionBreakdown}
              pathKey="root"
              rootItem={rootItem}
            />
          ) : (
            <div className="lineage-inspector-muted">{emptyText}</div>
          )}
        </div>
      </div>
    </section>
  );
}

function InspectorColumnTreeNodes({
  activeInspectorCardId,
  depth = 0,
  expandedExpressionColumnIds,
  nodes,
  onFocusNode,
  onSelectInspectorCard,
  onToggleExpressionBreakdown,
  pathKey,
  rootItem,
}: {
  activeInspectorCardId?: string | null;
  depth?: number;
  expandedExpressionColumnIds?: Set<string>;
  nodes: InspectorColumnTreeNode[];
  onFocusNode?: (nodeId: string) => void;
  onSelectInspectorCard?: SelectInspectorCard;
  onToggleExpressionBreakdown?: (columnId: string) => void;
  pathKey?: string;
  rootItem: InspectorColumnItem;
}) {
  const renderNodes = groupTerminalInspectorTreeNodes(nodes);
  return (
    <div className="lineage-inspector-tree" style={{ '--lineage-inspector-tree-depth': depth } as CSSProperties}>
      {renderNodes.map((entry, index) => {
        const cardId = `${pathKey ?? 'tree'}/${inspectorTreeEntryKey(entry, depth, index)}`;
        if (entry.kind === 'group') {
          return (
            <div className="lineage-inspector-tree-node" key={cardId}>
              <InspectorColumnGroupCard
                active={activeInspectorCardId === cardId}
                cardId={cardId}
                items={entry.items}
                onFocusNode={onFocusNode}
                onSelectInspectorCard={onSelectInspectorCard}
              />
            </div>
          );
        }

        if (entry.node.kind === 'rule') {
          return (
            <div className="lineage-inspector-tree-node" key={cardId}>
              <InspectorRuleCard
                active={activeInspectorCardId === cardId}
                cardId={cardId}
                onSelectInspectorCard={onSelectInspectorCard}
                ownerNode={entry.node.ownerNode}
                rootItem={entry.node.item}
                rule={entry.node.rule}
              />
              {entry.node.children.length > 0 ? (
                <InspectorColumnTreeNodes
                  activeInspectorCardId={activeInspectorCardId}
                  depth={depth + 1}
                  expandedExpressionColumnIds={expandedExpressionColumnIds}
                  nodes={entry.node.children}
                  onFocusNode={onFocusNode}
                  onSelectInspectorCard={onSelectInspectorCard}
                  onToggleExpressionBreakdown={onToggleExpressionBreakdown}
                  pathKey={cardId}
                  rootItem={rootItem}
                />
              ) : null}
            </div>
          );
        }

        if (entry.node.kind === 'expression') {
          return (
            <div className="lineage-inspector-tree-node" key={cardId}>
              <InspectorExpressionTreeCard expression={entry.node.expression} />
              {entry.node.children.length > 0 ? (
                <InspectorColumnTreeNodes
                  activeInspectorCardId={activeInspectorCardId}
                  depth={depth + 1}
                  expandedExpressionColumnIds={expandedExpressionColumnIds}
                  nodes={entry.node.children}
                  onFocusNode={onFocusNode}
                  onSelectInspectorCard={onSelectInspectorCard}
                  onToggleExpressionBreakdown={onToggleExpressionBreakdown}
                  pathKey={cardId}
                  rootItem={rootItem}
                />
              ) : null}
            </div>
          );
        }

        const treeNode = entry.node;
        return (
          <div className="lineage-inspector-tree-node" key={cardId}>
            <InspectorColumnCard
              active={activeInspectorCardId === cardId}
              cardId={cardId}
              expressionExpanded={expandedExpressionColumnIds?.has(treeNode.item.column.id)}
              hasExpressionBreakdown={Boolean(onToggleExpressionBreakdown && (treeNode.item.column.caseRules?.length || treeNode.item.column.expressionTree))}
              item={treeNode.item}
              onFocusNode={onFocusNode}
              onSelectInspectorCard={onSelectInspectorCard}
              onToggleExpressionBreakdown={() => onToggleExpressionBreakdown?.(treeNode.item.column.id)}
              selectable
            />
            {treeNode.children.length > 0 ? (
              <InspectorColumnTreeNodes
                activeInspectorCardId={activeInspectorCardId}
                depth={depth + 1}
                expandedExpressionColumnIds={expandedExpressionColumnIds}
                nodes={treeNode.children}
                onFocusNode={onFocusNode}
                onSelectInspectorCard={onSelectInspectorCard}
                onToggleExpressionBreakdown={onToggleExpressionBreakdown}
                pathKey={cardId}
                rootItem={rootItem}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

type InspectorColumnTreeRenderEntry =
  | { kind: 'node'; node: InspectorColumnTreeNode }
  | { items: InspectorColumnItem[]; kind: 'group' };

function groupTerminalInspectorTreeNodes(nodes: InspectorColumnTreeNode[]): InspectorColumnTreeRenderEntry[] {
  const entries: InspectorColumnTreeRenderEntry[] = [];
  const groups = new Map<string, { entry: Extract<InspectorColumnTreeRenderEntry, { kind: 'group' }>; index: number }>();

  nodes.forEach((node) => {
    if (isTerminalGroupableColumnNode(node)) {
      const groupKey = node.item.node.id;
      const existing = groups.get(groupKey);
      if (existing) {
        existing.entry.items.push(node.item);
        return;
      }

      const entry: InspectorColumnTreeRenderEntry = { items: [node.item], kind: 'group' };
      groups.set(groupKey, { entry, index: entries.length });
      entries.push(entry);
      return;
    }

    entries.push({ kind: 'node', node });
  });

  return entries;
}

function isTerminalGroupableColumnNode(node: InspectorColumnTreeNode): node is InspectorColumnTreeColumnNode {
  return node.kind === 'column' && node.children.length === 0 && (node.item.node.type === 'table' || node.item.node.type === 'output');
}

function inspectorTreeEntryKey(entry: InspectorColumnTreeRenderEntry, depth: number, index: number) {
  return entry.kind === 'group'
    ? `group:${entry.items[0]?.node.id ?? 'unknown'}:${entry.items.map((item) => item.column.id).join(',')}:${depth}:${index}`
    : inspectorTreeNodeKey(entry.node, depth, index);
}

function inspectorTreeNodeKey(node: InspectorColumnTreeNode, depth: number, index: number) {
  if (node.kind === 'rule') {
    return `rule:${node.ownerNode.id}:${node.rule.id}:${depth}:${index}`;
  }
  if (node.kind === 'expression') {
    return `expression:${node.ownerNode.id}:${node.expression.kind}:${node.expression.sql}:${depth}:${index}`;
  }
  return `${node.item.node.id}:${node.item.column.id}:${depth}:${index}`;
}

function InspectorColumnGroupCard({
  active,
  cardId,
  items,
  onFocusNode,
  onSelectInspectorCard,
}: {
  active?: boolean;
  cardId: string;
  items: InspectorColumnItem[];
  onFocusNode?: (nodeId: string) => void;
  onSelectInspectorCard?: SelectInspectorCard;
}) {
  const node = items[0]?.node;
  if (!node) {
    return null;
  }

  const focusNode = (event?: { stopPropagation: () => void }) => {
    event?.stopPropagation();
    onFocusNode?.(node.id);
  };
  const selectGroup = () =>
    onSelectInspectorCard?.(cardId, node.id, {
      columns: items.map((item) => inspectorItemToHighlightColumn(item)),
      kind: 'columns',
    });
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectGroup();
    }
  };

  return (
    <div
      aria-label={`Select ${node.label} columns`}
      className={`lineage-inspector-column-card lineage-inspector-column-group-card lineage-inspector-column-card-selectable ${active ? 'lineage-inspector-column-card-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={selectGroup}
      onKeyDown={handleKeyDown}
    >
      <div className="lineage-inspector-column-meta">
        <InspectorTypeBadge node={node} />
        <button className="lineage-inspector-node-link lineage-inspector-focus-button" type="button" onClick={focusNode}>
          {node.label}
        </button>
      </div>
      <div className="lineage-inspector-group-columns">
        {items.map((item) => (
          <div className="lineage-inspector-group-column" key={item.column.id}>
            <span className="lineage-inspector-column-name">{item.column.name}</span>
            {item.column.comments?.length ? <div className="lineage-inspector-card-note">{item.column.comments.join(' ')}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function InspectorRuleCard({
  active,
  cardId,
  onSelectInspectorCard,
  ownerNode,
  rootItem,
  rule,
}: {
  active?: boolean;
  cardId: string;
  onSelectInspectorCard?: SelectInspectorCard;
  ownerNode: LineageNode;
  rootItem: InspectorColumnItem;
  rule: LineageCaseRule;
}) {
  const ownerType = ownerNode.recursive ? 'recursive' : ownerNode.type;
  const selectRule = () =>
    onSelectInspectorCard?.(cardId, ownerNode.id, {
      column: inspectorItemToHighlightColumn(rootItem, mergeInspectorColumnRefs(rule.conditionUpstream, rule.resultUpstream)),
      kind: 'column',
    });
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectRule();
    }
  };
  return (
    <div
      className={`lineage-inspector-rule-card lineage-inspector-rule-card-selectable ${active ? 'lineage-inspector-rule-card-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={selectRule}
      onKeyDown={handleKeyDown}
    >
      <div className="lineage-inspector-rule-heading">
        <span className={`lineage-inspector-type lineage-inspector-type-expression lineage-inspector-type-expression-${ownerType}`}>EXPRESSION</span>
      </div>
      {rule.caseLabel ? <span className="lineage-inspector-rule-case">{rule.caseLabel}</span> : null}
      {rule.conditionSql ? <InspectorRuleSql label="Condition" sql={rule.conditionSql} /> : null}
      {rule.resultSql ? <InspectorRuleSql label="Result" sql={rule.resultSql} /> : null}
    </div>
  );
}

function InspectorRuleSql({ label, sql }: { label: string; sql: string }) {
  return (
    <span className="lineage-inspector-rule-sql">
      <span className="lineage-inspector-rule-label-text">{label}</span>
      <SqlCodeMirror className="lineage-inspector-rule-code" value={sql} />
    </span>
  );
}

function InspectorExpressionTreeCard({ expression }: { expression: LineageExpressionTree }) {
  if (expression.kind === 'column') {
    return (
      <div className="lineage-inspector-rule-card lineage-inspector-expression-tree-card">
        <div className="lineage-inspector-rule-heading">
          <span className="lineage-inspector-type lineage-inspector-type-expression">COLUMN</span>
          <span className="lineage-inspector-expression-node-text">{expression.sql}</span>
        </div>
      </div>
    );
  }

  if (expression.kind === 'operator') {
    return (
      <div className="lineage-inspector-rule-card lineage-inspector-expression-tree-card">
        <div className="lineage-inspector-rule-heading">
          <span className="lineage-inspector-type lineage-inspector-type-expression">OPERATOR</span>
          <span className="lineage-inspector-expression-node-text">{expression.operator}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="lineage-inspector-rule-card lineage-inspector-expression-tree-card">
      <div className="lineage-inspector-rule-heading">
        <span className="lineage-inspector-type lineage-inspector-type-expression">EXPRESSION</span>
      </div>
      <SqlCodeMirror className="lineage-inspector-rule-code" value={expression.sql} />
    </div>
  );
}

function InspectorColumnCard({
  active,
  cardId,
  expressionExpanded,
  hasExpressionBreakdown,
  hideExpression,
  item,
  onClearCaseRule,
  onFocusNode,
  onSelectInspectorCard,
  onToggleExpressionBreakdown,
  root,
  selectable,
  showSimpleExpression,
  showUsage,
}: {
  active?: boolean;
  cardId?: string;
  expressionExpanded?: boolean;
  hasExpressionBreakdown?: boolean;
  hideExpression?: boolean;
  item: InspectorColumnItem;
  onClearCaseRule?: () => void;
  onFocusNode?: (nodeId: string) => void;
  onSelectInspectorCard?: SelectInspectorCard;
  onToggleExpressionBreakdown?: () => void;
  root?: boolean;
  selectable?: boolean;
  showSimpleExpression?: boolean;
  showUsage?: boolean;
}) {
  const expressionSql =
    !hideExpression && item.column.expressionSql && (showSimpleExpression || !isSimpleColumnReference(item.column.expressionSql))
      ? item.column.expressionSql
      : undefined;
  const focusNode = (event?: { stopPropagation: () => void }) => {
    event?.stopPropagation();
    onFocusNode?.(item.node.id);
  };
  const selectWholeColumn = () => {
    if (selectable) {
      if (onClearCaseRule) {
        onClearCaseRule();
      } else {
        onSelectInspectorCard?.(cardId ?? inspectorItemKey(item), item.node.id, { column: inspectorItemToHighlightColumn(item), kind: 'column' });
      }
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!selectable) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectWholeColumn();
    }
  };
  return (
    <div
      aria-label={selectable ? `Select full column lineage for ${item.column.name}` : undefined}
      className={`lineage-inspector-column-card ${root ? 'lineage-inspector-root-card' : ''} ${selectable ? 'lineage-inspector-column-card-selectable' : ''} ${active ? 'lineage-inspector-column-card-active' : ''}`}
      role={selectable ? 'button' : undefined}
      tabIndex={selectable ? 0 : undefined}
      onClick={selectWholeColumn}
      onKeyDown={handleKeyDown}
    >
      <div className="lineage-inspector-column-meta">
        <InspectorTypeBadge node={item.node} />
        <button className="lineage-inspector-node-link lineage-inspector-focus-button" type="button" onClick={focusNode}>
          {item.node.label}
        </button>
      </div>
      <span className="lineage-inspector-column-name">{item.column.name}</span>
      {item.column.comments?.length ? <div className="lineage-inspector-card-note">{item.column.comments.join(' ')}</div> : null}
      {showUsage && item.column.usage ? <div className="lineage-inspector-card-note">{formatInspectorUsage(item.column)}</div> : null}
      {expressionSql ? <SqlCodeMirror className="lineage-inspector-inline-code" value={expressionSql} /> : null}
      {hasExpressionBreakdown ? (
        <button
          className="lineage-inspector-expression-toggle"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpressionBreakdown?.();
          }}
        >
          <span className="lineage-inspector-type lineage-inspector-type-expression">EXPRESSION</span>
          {expressionExpanded ? 'Collapse expression' : 'Expand expression'}
        </button>
      ) : null}
    </div>
  );
}

function inspectorItemKey(item: InspectorColumnItem) {
  return `${item.node.id}:${item.column.id}`;
}

function inspectorItemToHighlightColumn(item: InspectorColumnItem, upstreamRefs?: LineageColumnRef[]): GraphHighlightColumnTarget {
  return {
    columnId: item.column.id,
    columnName: item.column.name,
    nodeId: item.node.id,
    upstreamRefs,
  };
}

function inspectorSourceItemKey(item: InspectorColumnItem, index: number) {
  return `source:${item.node.id}:${item.column.id}:${index}`;
}

function applyOutputTitle(lineage: LineageModel, outputTitle: string | undefined): LineageModel {
  const normalizedTitle = outputTitle?.trim();
  if (!normalizedTitle) {
    return lineage;
  }

  let changed = false;
  const nodes = lineage.nodes.map((node) => {
    if (node.type !== 'output' || node.label === normalizedTitle) {
      return node;
    }
    changed = true;
    return { ...node, label: normalizedTitle };
  });

  return changed ? { ...lineage, nodes } : lineage;
}

function isSameGraphSelectionSnapshot(left: GraphSelectionSnapshot, right: GraphSelectionSnapshot) {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'none' || right.kind === 'none') {
    return left.kind === right.kind;
  }
  if (left.kind === 'node' && right.kind === 'node') {
    return left.nodeId === right.nodeId;
  }
  if (left.kind === 'column' && right.kind === 'column') {
    return left.nodeId === right.nodeId && left.columnId === right.columnId;
  }
  return false;
}

function readSelectionHistoryState(state: unknown): GraphSelectionSnapshot | null {
  if (!isRecord(state)) {
    return null;
  }

  const value = state[selectionHistoryStateKey];
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null;
  }
  if (value.kind === 'none') {
    return { kind: 'none' };
  }
  if (value.kind === 'node' && typeof value.nodeId === 'string') {
    return { kind: 'node', nodeId: value.nodeId };
  }
  if (
    value.kind === 'column' &&
    typeof value.nodeId === 'string' &&
    typeof value.columnId === 'string' &&
    typeof value.columnName === 'string'
  ) {
    return {
      columnId: value.columnId,
      columnName: value.columnName,
      kind: 'column',
      nodeId: value.nodeId,
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function InspectorTypeBadge({ node }: { node: LineageNode }) {
  const type = node.recursive ? 'recursive' : node.type;
  return <span className={`lineage-inspector-type lineage-inspector-type-${type}`}>{type}</span>;
}

function groupInspectorItemsByNode(items: InspectorColumnItem[]) {
  const groups: InspectorColumnGroup[] = [];
  const groupByNodeId = new Map<string, InspectorColumnGroup>();
  for (const item of items) {
    const existing = groupByNodeId.get(item.node.id);
    if (existing) {
      existing.items.push(item);
      continue;
    }

    const next = { items: [item] };
    groupByNodeId.set(item.node.id, next);
    groups.push(next);
  }
  return groups;
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
  selectedColumn: SelectedColumn,
  expandedExpressionColumnIds: Set<string>,
  upstreamRefs?: LineageColumnRef[],
): Extract<InspectorSelection, { kind: 'column' }> | null {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const selectedNode = nodesById.get(selectedColumn.nodeId);
  const selected = selectedNode?.columns.find((column) => column.id === selectedColumn.columnId);
  if (!selectedNode || !selected) {
    return null;
  }

  const downstreamByColumnKey = buildDownstreamColumnIndex(nodes);
  const initialUpstreamRefs = upstreamRefs ?? selected.upstream ?? [];
  const upstream = collectUpstreamColumns(nodesById, selectedNode.id, selected.name, initialUpstreamRefs);
  const downstream = collectDownstreamColumns(nodesById, downstreamByColumnKey, selectedNode.id, selected.name);
  const hasExpressionBreakdown = Boolean(selected.caseRules?.length || selected.expressionTree);
  const expressionExpanded = expandedExpressionColumnIds.has(selected.id);
  const upstreamTree =
    expressionExpanded && (selected.caseRules?.length || selected.expressionTree) && !upstreamRefs
      ? collectExpressionBreakdownTree(nodesById, selectedNode, selected, expandedExpressionColumnIds)
      : collectUpstreamColumnTree(nodesById, selectedNode.id, selected.name, expandedExpressionColumnIds, initialUpstreamRefs);
  const downstreamTree = collectDownstreamColumnTree(nodesById, downstreamByColumnKey, selectedNode.id, selected.name);
  const sources = upstream.filter((item) => (item.column.upstream ?? []).length === 0);
  return {
    kind: 'column',
    selected: { column: selected, node: selectedNode },
    sources: dedupeInspectorColumns(sources),
    upstream: dedupeInspectorColumns(upstream),
    upstreamTree,
    downstream: dedupeInspectorColumns(downstream),
    downstreamTree,
    expressionExpanded,
    hasExpressionBreakdown,
  };
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

function collectUpstreamColumns(
  nodesById: Map<string, LineageNode>,
  nodeId: string,
  columnName: string,
  upstreamRefs?: LineageColumnRef[],
) {
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

  if (upstreamRefs) {
    for (const ref of upstreamRefs) {
      const upstreamNode = nodesById.get(ref.nodeId);
      const upstreamColumn = upstreamNode?.columns.find((item) => item.name === ref.columnName);
      if (!upstreamNode || !upstreamColumn) {
        continue;
      }
      result.push({ column: upstreamColumn, node: upstreamNode });
      visit(ref.nodeId, ref.columnName);
    }
  } else {
    visit(nodeId, columnName);
  }
  return result;
}

function collectUpstreamColumnTree(
  nodesById: Map<string, LineageNode>,
  nodeId: string,
  columnName: string,
  expandedExpressionColumnIds: Set<string>,
  upstreamRefs?: LineageColumnRef[],
): InspectorColumnTreeNode[] {
  if (upstreamRefs) {
    return upstreamRefs
      .map((ref) => buildUpstreamColumnTreeNode(nodesById, ref, new Set([columnKey(nodeId, columnName)]), expandedExpressionColumnIds))
      .filter(isInspectorTreeNode);
  }

  const node = nodesById.get(nodeId);
  const column = node?.columns.find((item) => item.name === columnName);
  return (column?.upstream ?? [])
    .map((ref) => buildUpstreamColumnTreeNode(nodesById, ref, new Set([columnKey(nodeId, columnName)]), expandedExpressionColumnIds))
    .filter(isInspectorTreeNode);
}

function collectCaseRuleUpstreamTree(
  nodesById: Map<string, LineageNode>,
  nodeId: string,
  columnName: string,
  rules: LineageCaseRule[],
  expandedExpressionColumnIds: Set<string> = new Set(),
): InspectorColumnTreeNode[] {
  const ownerNode = nodesById.get(nodeId);
  if (!ownerNode) {
    return [];
  }
  const ownerColumn = ownerNode.columns.find((column) => column.name === columnName);
  if (!ownerColumn) {
    return [];
  }
  const rootPath = new Set([columnKey(nodeId, columnName)]);
  return rules.map((rule) => ({
    children: mergeInspectorColumnRefs(rule.conditionUpstream, rule.resultUpstream)
      .map((ref) => buildUpstreamColumnTreeNode(nodesById, ref, rootPath, expandedExpressionColumnIds))
      .filter(isInspectorTreeNode),
    item: { column: ownerColumn, node: ownerNode },
    kind: 'rule' as const,
    ownerNode,
    rule,
  }));
}

function collectExpressionBreakdownTree(
  nodesById: Map<string, LineageNode>,
  ownerNode: LineageNode,
  column: LineageColumn,
  expandedExpressionColumnIds: Set<string>,
): InspectorColumnTreeNode[] {
  if (column.caseRules?.length) {
    return collectCaseRuleUpstreamTree(nodesById, ownerNode.id, column.name, column.caseRules, expandedExpressionColumnIds);
  }

  if (column.expressionTree) {
    return [buildExpressionTreeNode(nodesById, ownerNode, column.expressionTree, new Set([columnKey(ownerNode.id, column.name)]), expandedExpressionColumnIds)];
  }

  return [];
}

function buildExpressionTreeNode(
  nodesById: Map<string, LineageNode>,
  ownerNode: LineageNode,
  expression: LineageExpressionTree,
  path: Set<string>,
  expandedExpressionColumnIds: Set<string>,
): InspectorColumnTreeNode {
  if (expression.kind === 'column') {
    const resolvedColumn = buildUpstreamColumnTreeNode(nodesById, expression.ref, path, expandedExpressionColumnIds);
    return {
      children: resolvedColumn ? [resolvedColumn] : [],
      expression,
      kind: 'expression',
      ownerNode,
    };
  }

  return {
    children:
      expression.kind === 'operator'
        ? expression.children.map((child) => buildExpressionTreeNode(nodesById, ownerNode, child, path, expandedExpressionColumnIds))
        : expression.upstream.map((ref) => buildUpstreamColumnTreeNode(nodesById, ref, path, expandedExpressionColumnIds)).filter(isInspectorTreeNode),
    expression,
    kind: 'expression',
    ownerNode,
  };
}

function buildUpstreamColumnTreeNode(
  nodesById: Map<string, LineageNode>,
  ref: LineageColumnRef,
  path: Set<string>,
  expandedExpressionColumnIds: Set<string>,
): InspectorColumnTreeNode | null {
  const upstreamNode = nodesById.get(ref.nodeId);
  const upstreamColumn = upstreamNode?.columns.find((item) => item.name === ref.columnName);
  if (!upstreamNode || !upstreamColumn) {
    return null;
  }

  const key = columnKey(ref.nodeId, ref.columnName);
  if (path.has(key)) {
    return { children: [], item: { column: upstreamColumn, node: upstreamNode }, kind: 'column' };
  }

  const nextPath = new Set(path);
  nextPath.add(key);
  const expressionChildren =
    expandedExpressionColumnIds.has(upstreamColumn.id) && (upstreamColumn.caseRules?.length || upstreamColumn.expressionTree)
      ? collectExpressionBreakdownTree(nodesById, upstreamNode, upstreamColumn, expandedExpressionColumnIds)
      : null;
  return {
    children:
      expressionChildren ??
      (upstreamColumn.upstream ?? [])
        .map((childRef) => buildUpstreamColumnTreeNode(nodesById, childRef, nextPath, expandedExpressionColumnIds))
        .filter(isInspectorTreeNode),
    item: { column: upstreamColumn, node: upstreamNode },
    kind: 'column',
  };
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

function collectDownstreamColumnTree(
  nodesById: Map<string, LineageNode>,
  downstreamByColumnKey: Map<string, Array<{ columnName: string; nodeId: string }>>,
  nodeId: string,
  columnName: string,
): InspectorColumnTreeNode[] {
  const buildNode = (ref: { columnName: string; nodeId: string }, path: Set<string>): InspectorColumnTreeNode | null => {
    const downstreamNode = nodesById.get(ref.nodeId);
    const downstreamColumn = downstreamNode?.columns.find((item) => item.name === ref.columnName);
    if (!downstreamNode || !downstreamColumn) {
      return null;
    }

    const key = columnKey(ref.nodeId, ref.columnName);
    if (path.has(key)) {
      return { children: [], item: { column: downstreamColumn, node: downstreamNode }, kind: 'column' };
    }

    const nextPath = new Set(path);
    nextPath.add(key);
    return {
      children: (downstreamByColumnKey.get(key) ?? []).map((childRef) => buildNode(childRef, nextPath)).filter(isInspectorTreeNode),
      item: { column: downstreamColumn, node: downstreamNode },
      kind: 'column',
    };
  };

  return (downstreamByColumnKey.get(columnKey(nodeId, columnName)) ?? [])
    .map((ref) => buildNode(ref, new Set([columnKey(nodeId, columnName)])))
    .filter(isInspectorTreeNode);
}

function isInspectorTreeNode(value: InspectorColumnTreeNode | null): value is InspectorColumnTreeNode {
  return value !== null;
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
  if (column.usage?.role === 'filter') {
    return 'Filter';
  }

  const reasons = column.usage?.reasons?.map(formatUsageReason) ?? ['Condition'];
  return `Used by: ${[...new Set(reasons)].join(', ')}`;
}

function resolveColumnHighlights(
  nodes: LineageNode[],
  selectedColumn: SelectedColumn,
  upstreamRefs?: LineageColumnRef[],
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

  const selectedNode = nodesById.get(selectedColumn.nodeId);
  const selected = selectedNode?.columns.find((column) => column.id === selectedColumn.columnId);
  const initialUpstreamRefs = upstreamRefs ?? selected?.upstream ?? [];
  if (initialUpstreamRefs.length > 0) {
    for (const ref of initialUpstreamRefs) {
      highlightedEdgeIds.add(edgeKey(ref.nodeId, selectedColumn.nodeId));
      visitUpstream(ref.nodeId, ref.columnName);
    }
  }
  visitDownstream(selectedColumn.nodeId, selectedColumn.columnName);
  highlightedColumnIds.delete(selectedColumn.columnId);
  sourceColumnIds.delete(selectedColumn.columnId);
  return { highlightedColumnIds, highlightedEdgeIds, sourceColumnIds };
}

function resolveHighlightTarget(
  nodes: LineageNode[],
  target: GraphHighlightTarget,
): { highlightedColumnIds: Set<string>; highlightedEdgeIds: Set<string>; sourceColumnIds: Set<string> } {
  const empty = { highlightedColumnIds: new Set<string>(), highlightedEdgeIds: new Set<string>(), sourceColumnIds: new Set<string>() };
  if (!target) {
    return empty;
  }

  const columns = target.kind === 'column' ? [target.column] : target.columns;
  const merged = empty;
  for (const column of columns) {
    const highlights = resolveColumnHighlights(nodes, column, column.upstreamRefs);
    for (const columnId of highlights.highlightedColumnIds) {
      merged.highlightedColumnIds.add(columnId);
    }
    for (const edgeId of highlights.highlightedEdgeIds) {
      merged.highlightedEdgeIds.add(edgeId);
    }
    for (const columnId of highlights.sourceColumnIds) {
      merged.sourceColumnIds.add(columnId);
    }
  }
  return merged;
}

function resolveSelectedCaseRuleRefs(
  nodes: LineageNode[],
  selectedColumn: SelectedColumn,
  caseRuleSelection?: CaseRuleSelection | null,
): LineageColumnRef[] | undefined {
  if (
    !caseRuleSelection ||
    caseRuleSelection.nodeId !== selectedColumn.nodeId ||
    caseRuleSelection.columnId !== selectedColumn.columnId
  ) {
    return undefined;
  }

  const rule = resolveSelectedCaseRule(nodes, selectedColumn, caseRuleSelection);
  if (!rule) {
    return undefined;
  }

  return mergeInspectorColumnRefs(rule.conditionUpstream, rule.resultUpstream);
}

function resolveSelectedCaseRule(
  nodes: LineageNode[],
  selectedColumn: SelectedColumn,
  caseRuleSelection?: CaseRuleSelection | null,
): LineageCaseRule | undefined {
  if (
    !caseRuleSelection ||
    caseRuleSelection.nodeId !== selectedColumn.nodeId ||
    caseRuleSelection.columnId !== selectedColumn.columnId
  ) {
    return undefined;
  }

  const node = nodes.find((item) => item.id === selectedColumn.nodeId);
  const column = node?.columns.find((item) => item.id === selectedColumn.columnId);
  return column?.caseRules?.find((item) => item.id === caseRuleSelection.ruleId);
}

function mergeInspectorColumnRefs(left: LineageColumnRef[], right: LineageColumnRef[]): LineageColumnRef[] {
  const refs: LineageColumnRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...left, ...right]) {
    const key = columnKey(ref.nodeId, ref.columnName);
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

function columnKey(nodeId: string, columnName: string) {
  return `${nodeId}:${columnName}`;
}

function edgeKey(sourceId: string, targetId: string) {
  return `${sourceId}-${targetId}`;
}

function canHideColumns(node: LineageNode, flowDirection: GraphFlowDirection) {
  if (flowDirection === 'upstream') {
    return node.type !== 'output';
  }

  return node.type !== 'table';
}

function createDefaultHiddenColumnNodeIds(nodes: LineageNode[], flowDirection: GraphFlowDirection) {
  return new Set(nodes.filter((node) => canHideColumns(node, flowDirection)).map((node) => node.id));
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

function getNodeSql(node: LineageNode): string | undefined {
  return node.querySql ?? node.cteExecutableSql;
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
