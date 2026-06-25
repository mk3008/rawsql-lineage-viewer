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
import { Copy, ExternalLink, Eye, EyeOff, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { GraphEdge, GraphNode } from '../domain/graph';
import type { LineageCaseRule, LineageColumn, LineageColumnRef, LineageEdge, LineageExpressionTree, LineageModel, LineageNode } from '../domain/lineage';
import { buildGraphModel, collectUnreachableCteNodeIds, type GraphFlowDirection } from '../graph/buildGraphModel';
import { collectCollapsibleUpstreamGroups, collectDefaultCollapsedGroupRootIds, collapseLineageGroups, type CollapsedLineageGroup } from '../graph/collapseGroups';
import { isSimpleColumnReference } from '../lineage/columnDisplay';
import { buildColumnDiagnosticPacket, type ColumnDiagnosticPacket } from '../lineage/diagnostics';
import { buildDiagnosticTreeViewModel } from '../lineage/diagnosticViewModel';
import { isUnionNode } from '../lineage/nodeKind';
import { problemIntentLabels, problemIntentOptions, type ProblemIntent } from '../lineage/problemIntent';
import { populationImpactLabelsByNodeIdForIntent, sourceDataValueLabelsByNodeIdForIntent } from '../lineage/problemIntentViewModel';
import { LineageNodeCard } from './LineageNodeCard';
import { SqlCodeMirror } from './SqlCodeMirror';

const nodeTypes = {
  lineageNode: LineageNodeCard,
};

const edgeTypes = {
  lineageDataFlow: LineageDataFlowEdge,
};

const defaultViewport = { x: 16, y: 72, zoom: 1 };
const inspectorCardHistoryStateKey = 'rawsqlLineageViewerInspectorCard';
const selectionHistoryStateKey = 'rawsqlLineageViewerSelection';

interface SelectedColumn {
  columnId: string;
  columnName: string;
  nodeId: string;
}

export interface GraphHighlightColumnTarget extends SelectedColumn {
  populationImpactLabelsByNodeId?: Record<string, string[]>;
  populationNodeIds?: string[];
  scopeId?: string;
  sourceDataLabelsByNodeId?: Record<string, string[]>;
  sourceDataNodeIds?: string[];
  upstreamRefs?: LineageColumnRef[];
}

export type GraphHighlightTarget =
  | { column: GraphHighlightColumnTarget; kind: 'column' }
  | { columns: GraphHighlightColumnTarget[]; kind: 'columns' }
  | {
      kind: 'nodes';
      nodeIds: string[];
      populationImpactLabelsByNodeId?: Record<string, string[]>;
      sourceDataLabelsByNodeId?: Record<string, string[]>;
      targetColumn?: GraphHighlightColumnTarget;
    }
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
  lineage?: LineageModel;
  node: LineageNode;
}

interface InspectorColumnGroup {
  alias?: string;
  items: InspectorColumnItem[];
}

type SelectInspectorCard = (cardId: string, nodeId?: string, target?: GraphHighlightTarget) => void;

export interface InspectorCardSelection {
  cardId: string;
  focusNodeId?: string;
  highlightTarget?: GraphHighlightTarget;
}

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
  activeInspectorFocusNodeId,
  autoInspectOutputNonce,
  caseRuleSelection,
  expandedExpressionColumnIds,
  focusTarget,
  flowDirection,
  highlightTargetRequest,
  lineage,
  onInspectorSelectionChange,
  onProblemIntentChange,
  outputTitle,
  problemIntent,
}: {
  activeInspectorFocusNodeId?: string | null;
  autoInspectOutputNonce?: number;
  caseRuleSelection?: CaseRuleSelection | null;
  expandedExpressionColumnIds?: Set<string>;
  focusTarget?: { nonce: number; nodeId: string } | null;
  flowDirection: GraphFlowDirection;
  highlightTargetRequest?: { nonce: number; target: GraphHighlightTarget } | null;
  lineage: LineageModel;
  onInspectorSelectionChange?: (selection: InspectorSelection) => void;
  onProblemIntentChange?: (intent: ProblemIntent) => void;
  outputTitle?: string;
  problemIntent: ProblemIntent;
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
  const previousGraphStructureKeyRef = useRef<string | null>(null);
  const previousNodeStructureKeyRef = useRef<string | null>(null);
  const previousAutoLayoutEnabledRef = useRef(true);
  const problemIntentRef = useRef(problemIntent);
  const suppressInitialOutputSelectionRef = useRef(true);
  const [autoGroupEnabled, setAutoGroupEnabled] = useState(true);
  const [autoGroupExpandedNodeId, setAutoGroupExpandedNodeId] = useState<string | null>(null);
  const [collapsedGroupRootIds, setCollapsedGroupRootIds] = useState<Set<string>>(() => collectDefaultCollapsedGroupRootIds(lineage));
  const collapsibleGroups = useMemo(() => collectCollapsibleUpstreamGroups(lineage), [lineage]);
  const effectiveCollapsedGroupRootIds = useMemo(
    () => (autoGroupEnabled ? createAutoCollapsedGroupRootIds(collapsibleGroups, autoGroupExpandedNodeId, lineage.edges) : collapsedGroupRootIds),
    [autoGroupEnabled, autoGroupExpandedNodeId, collapsibleGroups, collapsedGroupRootIds, lineage.edges],
  );
  const collapsedLineage = useMemo(() => collapseLineageGroups(lineage, effectiveCollapsedGroupRootIds), [effectiveCollapsedGroupRootIds, lineage]);
  const viewLineage = collapsedLineage.lineage;
  const displayLineage = useMemo(() => applyOutputTitle(viewLineage, outputTitle), [outputTitle, viewLineage]);
  const layoutLineage = useMemo(() => applyOutputTitle(lineage, outputTitle), [lineage, outputTitle]);
  const displayLineageRef = useRef(displayLineage);
  const layoutLineageRef = useRef(layoutLineage);
  const [showParameterNodes, setShowParameterNodes] = useState(false);
  const [showUnreachableCtes, setShowUnreachableCtes] = useState(false);
  const hasParameterNodes = useMemo(() => lineage.nodes.some((node) => node.type === 'parameter_table'), [lineage.nodes]);
  const hasUnreachableCtes = useMemo(() => collectUnreachableCteNodeIds(lineage).size > 0, [lineage]);
  const graphDisplayLineage = useMemo(
    () => (showParameterNodes ? displayLineage : hideParameterNodesForGraph(displayLineage)),
    [displayLineage, showParameterNodes],
  );
  const graphLayoutLineage = useMemo(
    () => (showParameterNodes ? layoutLineage : hideParameterNodesForGraph(layoutLineage)),
    [layoutLineage, showParameterNodes],
  );
  const baseGraph = useMemo(
    () => buildGraphModel(graphDisplayLineage, flowDirection, graphLayoutLineage, { showUnreachableCtes }),
    [flowDirection, graphDisplayLineage, graphLayoutLineage, showUnreachableCtes],
  );
  const hideableColumnNodeIds = useMemo(() => new Set(displayLineage.nodes.filter((node) => canHideColumns(node, flowDirection)).map((node) => node.id)), [displayLineage.nodes, flowDirection]);
  const [hiddenColumnNodeIds, setHiddenColumnNodeIds] = useState<Set<string>>(() => createDefaultHiddenColumnNodeIds(displayLineage.nodes, flowDirection));
  const [selectedColumn, setSelectedColumn] = useState<SelectedColumn | null>(null);
  const [highlightTarget, setHighlightTarget] = useState<GraphHighlightTarget>(null);
  const inspectorHighlightActiveRef = useRef(false);
  const initialOutputNodeId = useMemo(() => displayLineage.nodes.find((node) => node.type === 'output')?.id ?? null, [displayLineage.nodes]);
  const [selectedNodeCommentTargetId, setSelectedNodeCommentTargetId] = useState<string | null>(() =>
    initialOutputNodeId ? nodeCommentTargetId(initialOutputNodeId) : null,
  );
  const [autoExpandedColumnNodeId, setAutoExpandedColumnNodeId] = useState<string | null>(() => initialOutputNodeId);
  const [activeCommentTargetId, setActiveCommentTargetId] = useState<string | null>(() =>
    initialOutputNodeId ? nodeCommentTargetId(initialOutputNodeId) : null,
  );
  const [dismissedCommentTargetIds, setDismissedCommentTargetIds] = useState<Set<string>>(() => new Set());
  const showColumnCallouts = false;
  const showHeaderCallouts = false;
  const [expandedPassthroughNodeIds, setExpandedPassthroughNodeIds] = useState<Set<string>>(() => new Set());
  const [viewportZoom, setViewportZoom] = useState(1);
  const [showEdgeAliases, setShowEdgeAliases] = useState(false);
  const [autoLayoutEnabled, setAutoLayoutEnabled] = useState(true);
  const resetZoom = useCallback(() => {
    void flowInstanceRef.current?.setViewport(defaultViewport, { duration: 120 });
    setViewportZoom(1);
  }, []);
  const allColumnsHidden = hideableColumnNodeIds.size > 0 && [...hideableColumnNodeIds].every((nodeId) => hiddenColumnNodeIds.has(nodeId));
  useEffect(() => {
    problemIntentRef.current = problemIntent;
  }, [problemIntent]);
  useEffect(() => {
    if (!hasParameterNodes) {
      setShowParameterNodes(false);
    }
  }, [hasParameterNodes]);
  useEffect(() => {
    if (!hasUnreachableCtes) {
      setShowUnreachableCtes(false);
    }
  }, [hasUnreachableCtes]);
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
    if (autoGroupEnabled) {
      setAutoGroupExpandedNodeId((current) => (current === nodeId ? null : current));
      return;
    }
    setCollapsedGroupRootIds((current) => new Set(current).add(nodeId));
  }, [autoGroupEnabled]);
  const expandGroup = useCallback((nodeId: string) => {
    if (autoGroupEnabled) {
      setAutoGroupExpandedNodeId(nodeId);
      return;
    }
    setCollapsedGroupRootIds((current) => {
      if (!current.has(nodeId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(nodeId);
      for (const helperNodeId of collapsibleGroups.get(nodeId)?.helperNodeIds ?? []) {
        next.delete(helperNodeId);
      }
      return next;
    });
  }, [autoGroupEnabled, collapsibleGroups]);
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
    const diagnosticLineage = layoutLineageRef.current;
    inspectorHighlightActiveRef.current = false;
    setDismissedCommentTargetIds(new Set());

    if (selection.kind === 'node') {
      const node = currentLineage.nodes.find((item) => item.id === selection.nodeId);
      if (node) {
        const targetId = nodeCommentTargetId(node.id);
        setSelectedColumn(null);
        setHighlightTarget(null);
        setSelectedNodeCommentTargetId(targetId);
        setAutoExpandedColumnNodeId(node.id);
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
          ...resolvePopulationHighlightContext(diagnosticLineage, {
            columnId: column.id,
            columnName: column.name,
            nodeId: node.id,
            scopeId: column.scopeId,
          }, problemIntentRef.current),
          scopeId: column.scopeId,
        };
        setSelectedColumn(nextColumn);
        setHighlightTarget({ column: nextColumn, kind: 'column' });
        setActiveCommentTargetId(targetId);
        setAutoExpandedColumnNodeId(node.id);
        return;
      }
    }

    setSelectedColumn(null);
    setHighlightTarget(null);
    setSelectedNodeCommentTargetId(null);
    setAutoExpandedColumnNodeId(null);
    setActiveCommentTargetId(null);
  }, []);
  const selectNode = useCallback((nodeId: string) => {
    suppressInitialOutputSelectionRef.current = false;
    if (collapsedLineage.groups.has(nodeId)) {
      expandGroup(nodeId);
    }
    const targetId = nodeCommentTargetId(nodeId);
    const nextSelection: GraphSelectionSnapshot =
      selectedNodeCommentTargetId === targetId && !collapsedLineage.groups.has(nodeId)
        ? { kind: 'none' }
        : { kind: 'node', nodeId };
    commitSelectionHistory(nextSelection);
    applySelectionSnapshot(nextSelection);
  }, [applySelectionSnapshot, collapsedLineage.groups, commitSelectionHistory, expandGroup, selectedNodeCommentTargetId]);
  const inspectNode = useCallback((nodeId: string) => {
    suppressInitialOutputSelectionRef.current = false;
    if (collapsedLineage.groups.has(nodeId)) {
      expandGroup(nodeId);
    }
    const nextSelection: GraphSelectionSnapshot = { kind: 'node', nodeId };
    commitSelectionHistory(nextSelection);
    applySelectionSnapshot(nextSelection);
  }, [applySelectionSnapshot, collapsedLineage.groups, commitSelectionHistory, expandGroup]);
  const selectColumn = useCallback((nodeId: string, column: LineageColumn) => {
    suppressInitialOutputSelectionRef.current = false;
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
    () => resolveHighlightTarget(displayLineage.nodes, displayLineage.edges, highlightTarget),
    [displayLineage.edges, displayLineage.nodes, highlightTarget],
  );
  const activeLineageRootColumnIds = useMemo(() => {
    if (!highlightTarget) {
      return new Set<string>();
    }
    if (highlightTarget.kind === 'column') {
      return new Set([highlightTarget.column.columnId]);
    }
    if (highlightTarget.kind === 'nodes') {
      return highlightTarget.targetColumn ? new Set([highlightTarget.targetColumn.columnId]) : new Set<string>();
    }
    return new Set(highlightTarget.columns.map((column) => column.columnId));
  }, [highlightTarget]);
  const forcedVisibleColumnIds = useMemo(() => {
    const columnIds = new Set<string>();
    if (autoExpandedColumnNodeId) {
      const selectedNode = displayLineage.nodes.find((node) => node.id === autoExpandedColumnNodeId);
      for (const column of selectedNode?.columns ?? []) {
        columnIds.add(column.id);
      }
    }
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
  }, [activeLineageRootColumnIds, autoExpandedColumnNodeId, columnHighlights.highlightedColumnIds, columnHighlights.sourceColumnIds, displayLineage.nodes, selectedColumn]);
  const graphSelectedColumnId = activeLineageRootColumnIds.size === 1 ? [...activeLineageRootColumnIds][0] : selectedColumn?.columnId ?? null;
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
  const visibleNodeIdBySourceNodeId = useMemo(() => createVisibleNodeIdBySourceNodeId(collapsedLineage.groups), [collapsedLineage.groups]);
  const selectedNodeId = selectedNodeCommentTargetId?.replace(/^node:/, '') ?? null;
  const visibleActiveInspectorFocusNodeId = mapToVisibleNodeId(activeInspectorFocusNodeId, visibleNodeIdBySourceNodeId);
  const visibleSelectedNodeId = mapToVisibleNodeId(selectedNodeId, visibleNodeIdBySourceNodeId);
  const graphSelectedNodeId = visibleActiveInspectorFocusNodeId ?? visibleSelectedNodeId;
  const activeGraphSelection = useMemo(() => {
    const activeNodeIds = new Set<string>();
    const activeEdgeIds = new Set<string>();

    if (selectedColumn || columnHighlights.highlightedEdgeIds.size > 0) {
      if (visibleActiveInspectorFocusNodeId) {
        activeNodeIds.add(visibleActiveInspectorFocusNodeId);
      }
      if (selectedColumn) {
        activeNodeIds.add(mapToVisibleNodeId(selectedColumn.nodeId, visibleNodeIdBySourceNodeId) ?? selectedColumn.nodeId);
      }
      for (const edge of baseGraph.edges) {
        if (!columnHighlights.highlightedEdgeIds.has(edge.id)) {
          continue;
        }
        activeEdgeIds.add(edge.id);
        activeNodeIds.add(edge.source);
        activeNodeIds.add(edge.target);
      }
      for (const nodeId of columnHighlights.highlightedNodeIds) {
        activeNodeIds.add(mapToVisibleNodeId(nodeId, visibleNodeIdBySourceNodeId) ?? nodeId);
      }
      for (const nodeId of columnHighlights.highlightedSourceDataNodeIds) {
        activeNodeIds.add(mapToVisibleNodeId(nodeId, visibleNodeIdBySourceNodeId) ?? nodeId);
      }
      for (const edge of baseGraph.edges) {
        if (activeNodeIds.has(edge.source) && activeNodeIds.has(edge.target)) {
          activeEdgeIds.add(edge.id);
        }
      }
      return activeNodeIds.size > 0 ? { activeEdgeIds, activeNodeIds } : null;
    }

    if (visibleActiveInspectorFocusNodeId) {
      return collectUpstreamLineageSelection(visibleActiveInspectorFocusNodeId, displayLineage.edges);
    }

    if (visibleSelectedNodeId) {
      return collectUpstreamLineageSelection(visibleSelectedNodeId, displayLineage.edges);
    }

    return null;
  }, [
    columnHighlights.highlightedEdgeIds,
    columnHighlights.highlightedNodeIds,
    columnHighlights.highlightedSourceDataNodeIds,
    displayLineage.edges,
    baseGraph.edges,
    selectedColumn,
    visibleActiveInspectorFocusNodeId,
    visibleNodeIdBySourceNodeId,
    visibleSelectedNodeId,
  ]);
  const autoLayoutVisibleNodeIds = useMemo(() => {
    if (!autoLayoutEnabled || !activeGraphSelection || activeGraphSelection.activeNodeIds.size === 0) {
      return undefined;
    }

    return activeGraphSelection.activeNodeIds;
  }, [activeGraphSelection, autoLayoutEnabled]);
  const autoLayoutLayoutVisibleNodeIds = useMemo(() => {
    if (!autoLayoutVisibleNodeIds) {
      return undefined;
    }

    return expandCollapsedVisibleNodeIdsForLayout(autoLayoutVisibleNodeIds, collapsedLineage.groups);
  }, [autoLayoutVisibleNodeIds, collapsedLineage.groups]);
  const graph = useMemo(
    () =>
      buildGraphModel(graphDisplayLineage, flowDirection, graphLayoutLineage, {
        layoutVisibleNodeIds: autoLayoutLayoutVisibleNodeIds,
        showUnreachableCtes,
        visibleNodeIds: autoLayoutVisibleNodeIds,
      }),
    [autoLayoutLayoutVisibleNodeIds, autoLayoutVisibleNodeIds, flowDirection, graphDisplayLineage, graphLayoutLineage, showUnreachableCtes],
  );
  const inspectorSelection = useMemo<InspectorSelection>(() => {
    if (selectedColumn) {
      return resolveInspectorColumnSelection(
        layoutLineage,
        selectedColumn,
        expandedExpressionColumnIds ?? new Set(),
        resolveSelectedCaseRuleRefs(layoutLineage.nodes, selectedColumn, caseRuleSelection),
      );
    }

    if (selectedNodeCommentTargetId) {
      const nodeId = selectedNodeCommentTargetId.replace(/^node:/, '');
      const node = layoutLineage.nodes.find((item) => item.id === nodeId);
      return node ? { kind: 'node', node } : null;
    }

    return null;
  }, [caseRuleSelection, expandedExpressionColumnIds, layoutLineage, selectedColumn, selectedNodeCommentTargetId]);
  useEffect(() => {
    displayLineageRef.current = displayLineage;
  }, [displayLineage]);
  useEffect(() => {
    layoutLineageRef.current = layoutLineage;
  }, [layoutLineage]);
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const initialSelection: GraphSelectionSnapshot = initialOutputNodeId ? { kind: 'node', nodeId: initialOutputNodeId } : { kind: 'none' };
    suppressInitialOutputSelectionRef.current = true;
    lastCommittedSelectionRef.current = initialSelection;
    applySelectionSnapshot(initialSelection);
    commitSelectionHistory(initialSelection, 'replace');

    const handlePopState = (event: PopStateEvent) => {
      if (isRecord(event.state) && inspectorCardHistoryStateKey in event.state) {
        return;
      }
      const selection = readSelectionHistoryState(event.state) ?? { kind: 'none' };
      lastCommittedSelectionRef.current = selection;
      applySelectionSnapshot(selection);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [applySelectionSnapshot, commitSelectionHistory, initialOutputNodeId]);
  useEffect(() => {
    if (
      suppressInitialOutputSelectionRef.current &&
      inspectorSelection?.kind === 'node' &&
      inspectorSelection.node.id === initialOutputNodeId
    ) {
      return;
    }
    suppressInitialOutputSelectionRef.current = false;
    onInspectorSelectionChange?.(inspectorSelection);
  }, [initialOutputNodeId, inspectorSelection, onInspectorSelectionChange]);
  useEffect(() => {
    if (!autoInspectOutputNonce || lastHandledAutoInspectOutputNonceRef.current === autoInspectOutputNonce) {
      return;
    }

    lastHandledAutoInspectOutputNonceRef.current = autoInspectOutputNonce;
    const outputNode = displayLineage.nodes.find((node) => node.type === 'output');
    if (outputNode) {
      suppressInitialOutputSelectionRef.current = false;
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
  useEffect(() => {
    if (!selectedColumn) {
      return;
    }

    const node = displayLineage.nodes.find((item) => item.id === selectedColumn.nodeId);
    const column = node?.columns.find((item) => item.id === selectedColumn.columnId);
    if (!node || !column) {
      return;
    }

    const nextColumn = {
      columnId: column.id,
      columnName: column.name,
      nodeId: node.id,
      ...resolvePopulationHighlightContext(layoutLineage, {
        columnId: column.id,
        columnName: column.name,
        nodeId: node.id,
        scopeId: column.scopeId,
      }, problemIntent),
      scopeId: column.scopeId,
    };
    setSelectedColumn(nextColumn);
    if (!inspectorHighlightActiveRef.current) {
      setHighlightTarget({ column: nextColumn, kind: 'column' });
    }
  }, [displayLineage.nodes, layoutLineage, problemIntent, selectedColumn?.columnId, selectedColumn?.columnName, selectedColumn?.nodeId]);
  const graphNodes = useMemo<GraphNode[]>(
    () =>
      graph.nodes.map((node) => ({
        ...node,
        zIndex: nodeHasSelectedComment(node.data.lineageNode, selectedCommentTargetIds) ? 1000 : node.zIndex,
        data: {
          ...node.data,
          canToggleColumns: false,
          canCollapseUpstream: collapsibleGroups.has(node.id),
          collapsedGroup: collapsedLineage.groups.get(node.id),
          showGroupControls: !autoGroupEnabled,
          columnsVisible: !hiddenColumnNodeIds.has(node.id),
          forcedVisibleColumnIds,
          onCollapseUpstream: collapseUpstream,
          onExpandGroup: expandGroup,
          onNodeSelect: selectNode,
          onColumnSelect: selectColumn,
          dimmed: activeGraphSelection ? !activeGraphSelection.activeNodeIds.has(node.id) : false,
          selectedNodeId: graphSelectedNodeId,
          selectedColumnId: graphSelectedColumnId,
          selectedCommentTargetIds,
          selectedRuleExpressionByColumnId,
          activeCommentTargetId,
          viewportZoom,
          activeLineageRootColumnIds,
          highlightedNodeIds: columnHighlights.highlightedNodeIds,
          highlightedColumnIds: columnHighlights.highlightedColumnIds,
          highlightedNodeImpactLabels: columnHighlights.highlightedNodeImpactLabels,
          highlightedNodeTone: columnHighlights.nodeTone,
          highlightedSourceDataLabels: columnHighlights.highlightedSourceDataLabels,
          highlightedSourceDataNodeIds: columnHighlights.highlightedSourceDataNodeIds,
          onTogglePassthroughColumns: togglePassthroughColumns,
          passthroughColumnsCompressed: node.data.lineageNode.type !== 'output' && !expandedPassthroughNodeIds.has(node.id),
          sourceColumnIds: columnHighlights.sourceColumnIds,
          onCommentClose: closeComment,
          onCommentFocus: focusComment,
        },
      })),
    [
      columnHighlights.highlightedEdgeIds,
      columnHighlights.highlightedColumnIds,
      columnHighlights.highlightedNodeImpactLabels,
      columnHighlights.highlightedNodeIds,
      columnHighlights.highlightedSourceDataLabels,
      columnHighlights.highlightedSourceDataNodeIds,
      columnHighlights.sourceColumnIds,
      activeGraphSelection,
      autoGroupEnabled,
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
      graphSelectedNodeId,
      selectedColumn?.columnId,
      selectedRuleExpressionByColumnId,
      selectedCommentTargetIds,
      togglePassthroughColumns,
    ],
  );
  const graphEdges = useMemo<GraphEdge[]>(
    () =>
      graph.edges.map((edge) => {
        const edgeDimmed = activeGraphSelection ? !activeGraphSelection.activeEdgeIds.has(edge.id) : false;
        const displayEdge = showEdgeAliases
          ? edge
          : {
              ...edge,
              label: undefined,
              labelBgPadding: undefined,
              labelBgBorderRadius: undefined,
            };
        const dimmedEdge = edgeDimmed
          ? {
              ...displayEdge,
              className: [displayEdge.className, 'lineage-edge-dimmed'].filter(Boolean).join(' '),
              style: {
                ...(displayEdge.style ?? {}),
                opacity: 0.16,
              },
            }
          : displayEdge;

        if (!columnHighlights.highlightedEdgeIds.has(edge.id)) {
          return dimmedEdge;
        }

        const baseStyle = dimmedEdge.style ?? {};
        return {
          ...dimmedEdge,
          animated: false,
          zIndex: 1000,
          style: {
            ...baseStyle,
            stroke: columnHighlights.edgeTone === 'population' ? '#f59e0b' : '#2563eb',
            strokeWidth: 4,
          },
          markerEnd:
            edge.markerEnd && typeof edge.markerEnd === 'object'
              ? {
                  ...edge.markerEnd,
                  color: columnHighlights.edgeTone === 'population' ? '#f59e0b' : '#2563eb',
                }
              : edge.markerEnd,
        };
      }),
    [activeGraphSelection, columnHighlights.edgeTone, columnHighlights.highlightedEdgeIds, graph.edges, showEdgeAliases],
  );
  const graphStructureKey = useMemo(
    () =>
      [
        graph.nodes.map((node) => node.id).join('|'),
        graph.edges.map((edge) => `${edge.id}:${edge.source}->${edge.target}`).join('|'),
      ].join('::'),
    [graph.edges, graph.nodes],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(graphNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphEdges);

  useEffect(() => {
    if (previousLineageRef.current !== lineage || previousFlowDirectionRef.current !== flowDirection) {
      previousLineageRef.current = lineage;
      previousFlowDirectionRef.current = flowDirection;
      previousNodeStructureKeyRef.current = graphStructureKey;
      previousAutoLayoutEnabledRef.current = autoLayoutEnabled;
      nodePositionsRef.current = new Map(graphNodes.map((node) => [node.id, node.position]));
      setNodes(graphNodes);
      return;
    }

    const graphStructureChanged =
      previousNodeStructureKeyRef.current !== null && previousNodeStructureKeyRef.current !== graphStructureKey;
    const autoLayoutJustEnabled = autoLayoutEnabled && !previousAutoLayoutEnabledRef.current;
    previousNodeStructureKeyRef.current = graphStructureKey;
    previousAutoLayoutEnabledRef.current = autoLayoutEnabled;

    setNodes((currentNodes) => {
      const currentById = new Map(currentNodes.map((node) => [node.id, node]));
      return graphNodes.map((node) => {
        const current = currentById.get(node.id);
        if (autoLayoutEnabled && (graphStructureChanged || autoLayoutJustEnabled)) {
          return {
            ...node,
            dragging: current?.dragging,
            measured: current?.measured,
            selected: current?.selected,
          };
        }

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
  }, [autoLayoutEnabled, flowDirection, graphNodes, graphStructureKey, lineage, setNodes]);

  useEffect(() => {
    for (const node of nodes) {
      nodePositionsRef.current.set(node.id, node.position);
    }
  }, [nodes]);

  useEffect(() => {
    const graphStructureChanged =
      previousGraphStructureKeyRef.current !== null && previousGraphStructureKeyRef.current !== graphStructureKey;
    previousGraphStructureKeyRef.current = graphStructureKey;

    if (!graphStructureChanged) {
      setEdges(graphEdges);
      return;
    }

    setEdges([]);
    const animationFrameId = window.requestAnimationFrame(() => {
      setEdges(graphEdges);
    });
    return () => window.cancelAnimationFrame(animationFrameId);
  }, [graphEdges, graphStructureKey, setEdges]);

  useEffect(() => {
    if (!focusTarget) {
      return;
    }
    if (autoGroupEnabled) {
      setAutoGroupExpandedNodeId(focusTarget.nodeId);
    }
  }, [autoGroupEnabled, focusTarget?.nodeId, focusTarget?.nonce]);

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

    const timeoutId = window.setTimeout(() => {
      const shell = graphShellRef.current;
      if (!shell) {
        return;
      }

      const shellRect = shell.getBoundingClientRect();
      const height = targetNode.measured?.height ?? targetNode.height ?? 140;
      const zoom = viewportZoom;
      const leftPadding = 48;
      const x = leftPadding - targetNode.position.x * zoom;
      const y = shellRect.height / 2 - (targetNode.position.y + height / 2) * zoom;

      lastHandledFocusNonceRef.current = focusTarget.nonce;
      void flowInstanceRef.current?.setViewport({ x, y, zoom }, { duration: 220 });
    }, 200);

    return () => window.clearTimeout(timeoutId);
  }, [focusTarget?.nodeId, focusTarget?.nonce, nodes, viewportZoom]);

  useEffect(() => {
    if (!highlightTargetRequest) {
      return;
    }
    if (lastHandledHighlightNonceRef.current === highlightTargetRequest.nonce) {
      return;
    }

    lastHandledHighlightNonceRef.current = highlightTargetRequest.nonce;
    inspectorHighlightActiveRef.current = highlightTargetRequest.target !== null;
    setHighlightTarget(highlightTargetRequest.target);
  }, [highlightTargetRequest?.nonce, highlightTargetRequest?.target]);

  useEffect(() => {
    setDismissedCommentTargetIds(new Set());
    setHiddenColumnNodeIds(createDefaultHiddenColumnNodeIds(lineage.nodes, flowDirection));
    setCollapsedGroupRootIds(collectDefaultCollapsedGroupRootIds(lineage));
    setAutoGroupExpandedNodeId(null);
    setExpandedPassthroughNodeIds(new Set());
    const initialSelection: GraphSelectionSnapshot = initialOutputNodeId ? { kind: 'node', nodeId: initialOutputNodeId } : { kind: 'none' };
    suppressInitialOutputSelectionRef.current = true;
    applySelectionSnapshot(initialSelection);
    commitSelectionHistory(initialSelection, 'replace');
  }, [applySelectionSnapshot, commitSelectionHistory, flowDirection, initialOutputNodeId, lineage]);

  return (
    <div className="graph-shell" data-testid="lineage-graph" ref={graphShellRef}>
      <div className="graph-display-controls nodrag" aria-label="Graph display options">
        <ProblemIntentSelector intent={problemIntent} onChange={onProblemIntentChange} />
        <button className="graph-column-toggle" type="button" onClick={toggleAllColumns}>
          {allColumnsHidden ? <Eye size={15} /> : <EyeOff size={15} />}
          {allColumnsHidden ? 'Always show columns' : 'Minimize columns'}
        </button>
        <label className="graph-alias-toggle">
          <input aria-label="Show aliases" type="checkbox" checked={showEdgeAliases} onChange={(event) => setShowEdgeAliases(event.target.checked)} />
          Aliases
        </label>
        {hasParameterNodes ? (
          <label className="graph-alias-toggle">
            <input aria-label="Show parameters" type="checkbox" checked={showParameterNodes} onChange={(event) => setShowParameterNodes(event.target.checked)} />
            Parameters
          </label>
        ) : null}
        {hasUnreachableCtes ? (
          <label className="graph-alias-toggle">
            <input aria-label="Show unused CTEs" type="checkbox" checked={showUnreachableCtes} onChange={(event) => setShowUnreachableCtes(event.target.checked)} />
            Unused CTEs
          </label>
        ) : null}
        <label className="graph-alias-toggle">
          <input aria-label="Auto group" type="checkbox" checked={autoGroupEnabled} onChange={(event) => {
            setAutoGroupEnabled(event.target.checked);
            setAutoGroupExpandedNodeId(null);
          }} />
          Auto group
        </label>
        <label className="graph-alias-toggle">
          <input aria-label="Auto layout" type="checkbox" checked={autoLayoutEnabled} onChange={(event) => setAutoLayoutEnabled(event.target.checked)} />
          Auto layout
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
              const lineageNode = (node.data as { lineageNode?: LineageNode } | undefined)?.lineageNode;
              const type = lineageNode?.type;
              if (type === 'table') return '#dbeafe';
              if (type === 'cte') return '#dcfce7';
              if (type === 'parameter_table') return '#ccfbf1';
              if (type === 'output') return '#f3e8ff';
              if (lineageNode && isUnionNode(lineageNode)) return '#ffe4e6';
              return '#fef3c7';
            }}
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

function collectUpstreamLineageSelection(rootNodeId: string, edges: LineageEdge[]) {
  const activeNodeIds = new Set<string>([rootNodeId]);
  const activeEdgeIds = new Set<string>();
  const queue = [rootNodeId];

  while (queue.length > 0) {
    const currentNodeId = queue.shift();
    if (!currentNodeId) {
      continue;
    }

    for (const edge of edges) {
      if (edge.type !== 'dataFlow' || edge.target !== currentNodeId) {
        continue;
      }

      activeEdgeIds.add(edge.id);

      const nextNodeId = edge.source;
      if (!activeNodeIds.has(nextNodeId)) {
        activeNodeIds.add(nextNodeId);
        queue.push(nextNodeId);
      }
    }
  }

  return { activeEdgeIds, activeNodeIds };
}

function createVisibleNodeIdBySourceNodeId(groups: Map<string, { helperNodeIds: string[] }>) {
  const visibleNodeIdBySourceNodeId = new Map<string, string>();
  for (const [rootNodeId, group] of groups) {
    visibleNodeIdBySourceNodeId.set(rootNodeId, rootNodeId);
    for (const helperNodeId of group.helperNodeIds) {
      visibleNodeIdBySourceNodeId.set(helperNodeId, rootNodeId);
    }
  }
  return visibleNodeIdBySourceNodeId;
}

function expandCollapsedVisibleNodeIdsForLayout(
  visibleNodeIds: Set<string>,
  groups: Map<string, CollapsedLineageGroup>,
) {
  if (groups.size === 0) {
    return visibleNodeIds;
  }

  const expandedNodeIds = new Set(visibleNodeIds);
  for (const nodeId of visibleNodeIds) {
    const group = groups.get(nodeId);
    if (!group) {
      continue;
    }

    expandedNodeIds.add(group.rootNodeId);
    for (const helperNodeId of group.helperNodeIds) {
      expandedNodeIds.add(helperNodeId);
    }
    for (const sourceNodeId of group.sourceNodeIds) {
      expandedNodeIds.add(sourceNodeId);
    }
  }

  return expandedNodeIds;
}

function mapToVisibleNodeId(nodeId: string | null | undefined, visibleNodeIdBySourceNodeId: Map<string, string>) {
  if (!nodeId) {
    return null;
  }
  return visibleNodeIdBySourceNodeId.get(nodeId) ?? nodeId;
}

export function LineageInspector({
  activeCaseRule,
  expandedExpressionColumnIds,
  lineage,
  onClearCaseRule,
  onFocusNode,
  onHighlightTarget,
  onClearInspectorCard,
  onDeleteOutputTitle,
  onRenameOutputTitle,
  onSelectInspectorCard,
  onToggleExpressionBreakdown,
  problemIntent,
  selection,
  activeInspectorCardId,
}: {
  activeInspectorCardId?: string | null;
  activeCaseRule?: CaseRuleSelection | null;
  expandedExpressionColumnIds?: Set<string>;
  lineage: LineageModel;
  onClearInspectorCard?: (recordHistory?: boolean) => void;
  onClearCaseRule?: () => void;
  onFocusNode?: (nodeId: string) => void;
  onHighlightTarget?: (target: GraphHighlightTarget) => void;
  onDeleteOutputTitle?: () => void;
  onRenameOutputTitle?: (title: string) => void;
  onSelectInspectorCard?: (selection: InspectorCardSelection) => void;
  onToggleExpressionBreakdown?: (columnId: string) => void;
  problemIntent: ProblemIntent;
  selection: InspectorSelection;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [editingOutputTitle, setEditingOutputTitle] = useState(false);
  const [confirmDeleteOutputTitle, setConfirmDeleteOutputTitle] = useState(false);
  const [draftOutputTitle, setDraftOutputTitle] = useState('');
  const selectedNode = selection?.kind === 'node' ? selection.node : undefined;
  const canRenameOutput = selectedNode?.type === 'output' && Boolean(onRenameOutputTitle);
  const canDeleteOutput = selectedNode?.type === 'output' && Boolean(onDeleteOutputTitle);
  const inspectorTitle = selection ? (selection.kind === 'column' ? selection.selected.column.name : selection.node.label) : 'No selection';

  useEffect(() => {
    if (!editingOutputTitle) {
      setDraftOutputTitle(selectedNode?.label ?? '');
    }
  }, [editingOutputTitle, selectedNode?.label]);
  useEffect(() => {
    setConfirmDeleteOutputTitle(false);
  }, [selectedNode?.id, selectedNode?.label]);

  const startEditingOutputTitle = () => {
    setDraftOutputTitle(selectedNode?.label ?? '');
    setConfirmDeleteOutputTitle(false);
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
  const requestDeleteOutputTitle = () => {
    if (!confirmDeleteOutputTitle) {
      setConfirmDeleteOutputTitle(true);
      return;
    }
    onDeleteOutputTitle?.();
    setConfirmDeleteOutputTitle(false);
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
            <h2>
              {canRenameOutput ? (
                <button className="lineage-inspector-title-button" type="button" onClick={startEditingOutputTitle}>
                  {inspectorTitle}
                </button>
              ) : (
                inspectorTitle
              )}
            </h2>
          )}
        </div>
        {canRenameOutput && !editingOutputTitle ? (
          <div className="lineage-output-title-actions">
            <button className="lineage-copy-button lineage-output-title-edit-button" type="button" onClick={startEditingOutputTitle}>
              <Pencil size={12} aria-hidden="true" />
              Edit
            </button>
            {canDeleteOutput ? (
              <button
                className={`lineage-copy-button lineage-output-title-delete-button ${confirmDeleteOutputTitle ? 'lineage-output-title-delete-confirm' : ''}`}
                type="button"
                onClick={requestDeleteOutputTitle}
              >
                <Trash2 size={12} aria-hidden="true" />
                {confirmDeleteOutputTitle ? 'Confirm' : 'Delete'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {selection ? (
        selection.kind === 'column' ? (
          <ColumnInspector
            activeCaseRule={activeCaseRule}
            expandedExpressionColumnIds={expandedExpressionColumnIds}
            lineage={lineage}
            activeInspectorCardId={activeInspectorCardId}
            onClearCaseRule={onClearCaseRule}
            onClearInspectorCard={onClearInspectorCard}
            onFocusNode={onFocusNode}
            onHighlightTarget={onHighlightTarget}
            onSelectInspectorCard={onSelectInspectorCard}
            onToggleExpressionBreakdown={onToggleExpressionBreakdown}
            problemIntent={problemIntent}
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
  lineage,
  onClearCaseRule,
  onFocusNode,
  onHighlightTarget,
  onClearInspectorCard,
  onSelectInspectorCard,
  onToggleExpressionBreakdown,
  problemIntent,
  selection,
  activeInspectorCardId,
}: {
  activeInspectorCardId?: string | null;
  activeCaseRule?: CaseRuleSelection | null;
  expandedExpressionColumnIds?: Set<string>;
  lineage: LineageModel;
  onClearCaseRule?: () => void;
  onClearInspectorCard?: (recordHistory?: boolean) => void;
  onFocusNode?: (nodeId: string) => void;
  onHighlightTarget?: (target: GraphHighlightTarget) => void;
  onSelectInspectorCard?: (selection: InspectorCardSelection) => void;
  onToggleExpressionBreakdown?: (columnId: string) => void;
  problemIntent: ProblemIntent;
  selection: Extract<InspectorSelection, { kind: 'column' }>;
}) {
  const [activeTab, setActiveTab] = useState<'diagnostics' | 'sql' | 'upstream'>('upstream');
  const [diagnosticCopyState, setDiagnosticCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const diagnosticPacket = useMemo(
    () => buildColumnDiagnosticPacket(lineage, {
      columnName: selection.selected.column.name,
      nodeId: selection.selected.node.id,
      scopeId: selection.selected.column.scopeId,
    }),
    [lineage, selection.selected.column.name, selection.selected.column.scopeId, selection.selected.node.id],
  );
  const scopeSql = useMemo(
    () => getColumnScopeSql(lineage, selection.selected.column.scopeId, selection.selected.node.id),
    [lineage, selection.selected.column.scopeId, selection.selected.node.id],
  );
  const executableScopeSql = useMemo(
    () => getColumnExecutableSql(lineage, selection.selected.column.scopeId, selection.selected.node.id) ?? scopeSql,
    [lineage, scopeSql, selection.selected.column.scopeId, selection.selected.node.id],
  );
  useEffect(() => {
    setActiveTab('upstream');
  }, [selection.selected.column.id, selection.selected.node.id]);
  const selectWholeColumn = () => {
    onClearInspectorCard?.(true);
    onFocusNode?.(selection.selected.node.id);
    onHighlightTarget?.({
      column: {
        ...inspectorItemToHighlightColumn(selection.selected),
        populationNodeIds: populationNodeIdsFromPacket(diagnosticPacket, problemIntent),
        populationImpactLabelsByNodeId: populationImpactLabelsByNodeIdFromPacket(diagnosticPacket, problemIntent),
        sourceDataLabelsByNodeId: sourceDataLabelsByNodeIdFromPacket(diagnosticPacket, problemIntent),
        sourceDataNodeIds: sourceDataNodeIdsFromPacket(diagnosticPacket, problemIntent),
      },
      kind: 'column',
    });
    onClearCaseRule?.();
  };
  const toggleExpressionBreakdown = () => {
    onClearInspectorCard?.();
    onClearCaseRule?.();
    onToggleExpressionBreakdown?.(selection.selected.column.id);
  };
  const selectInspectorCard = (cardId: string, nodeId?: string, target?: GraphHighlightTarget) => {
    onSelectInspectorCard?.({ cardId, focusNodeId: nodeId, highlightTarget: target });
  };
  const copyDiagnosticJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnosticPacket, null, 2));
      setDiagnosticCopyState('copied');
      window.setTimeout(() => setDiagnosticCopyState('idle'), 1600);
    } catch {
      setDiagnosticCopyState('failed');
      window.setTimeout(() => setDiagnosticCopyState('idle'), 2200);
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
        <div className="lineage-inspector-tabs lineage-inspector-tabs-three" role="tablist" aria-label="Inspector details">
          <button
            aria-selected={activeTab === 'sql'}
            className={activeTab === 'sql' ? 'lineage-inspector-tab-active' : ''}
            role="tab"
            type="button"
            onClick={() => setActiveTab('sql')}
          >
            SQL
          </button>
          <button
            aria-selected={activeTab === 'upstream'}
            className={activeTab === 'upstream' ? 'lineage-inspector-tab-active' : ''}
            role="tab"
            type="button"
            onClick={() => setActiveTab('upstream')}
          >
            Upstream
          </button>
          <button
            aria-selected={activeTab === 'diagnostics'}
            className={activeTab === 'diagnostics' ? 'lineage-inspector-tab-active' : ''}
            role="tab"
            type="button"
            onClick={() => setActiveTab('diagnostics')}
          >
            Diagnostics
          </button>
        </div>
        <div className="lineage-inspector-tab-panel" role="tabpanel">
          {activeTab === 'sql' ? (
            <ColumnScopeSqlPanel executableSql={executableScopeSql} sql={scopeSql} />
          ) : activeTab === 'upstream' ? (
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
            <ColumnDiagnosticPacketPanel
              activeInspectorCardId={activeInspectorCardId}
              activeRoot={!activeCaseRule && activeInspectorCardId === null}
              copyState={diagnosticCopyState}
              expandedExpressionColumnIds={expandedExpressionColumnIds}
              expressionExpanded={selection.expressionExpanded}
              hasExpressionBreakdown={selection.hasExpressionBreakdown}
              onClearRoot={selectWholeColumn}
              packet={diagnosticPacket}
              problemIntent={problemIntent}
              rootItem={selection.selected}
              tree={selection.upstreamTree}
              onFocusNode={onFocusNode}
              onHighlightTarget={onHighlightTarget}
              onCopyJson={() => void copyDiagnosticJson()}
              onSelectInspectorCard={selectInspectorCard}
              onToggleColumnExpressionBreakdown={onToggleExpressionBreakdown}
              onToggleRootExpressionBreakdown={toggleExpressionBreakdown}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function ColumnScopeSqlPanel({ executableSql, sql }: { executableSql?: string; sql?: string }) {
  const [includeCtes, setIncludeCtes] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const displaySql = includeCtes ? executableSql ?? sql : sql ?? executableSql;

  const copyExecutableSql = async () => {
    if (!executableSql) {
      return;
    }

    try {
      await navigator.clipboard.writeText(executableSql);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      setCopyState('failed');
      window.setTimeout(() => setCopyState('idle'), 2200);
    }
  };

  if (!displaySql) {
    return (
      <section className="lineage-inspector-section">
        <p className="lineage-inspector-muted">No SQL is available for this scope.</p>
      </section>
    );
  }

  return (
    <section className="lineage-inspector-section lineage-inspector-sql-section">
      <div className="lineage-inspector-actions lineage-inspector-sql-actions">
        <div className="lineage-inspector-sql-actions-left">
          <label className="lineage-inspector-sql-toggle">
            <input type="checkbox" checked={includeCtes} onChange={(event) => setIncludeCtes(event.currentTarget.checked)} />
            <span>CTE</span>
          </label>
        </div>
        <div className="lineage-inspector-sql-actions-right">
          <a
            aria-disabled={!executableSql}
            className={`lineage-open-link nodrag ${executableSql ? '' : 'lineage-action-disabled'}`}
            href={executableSql ? buildViewerSqlUrl(executableSql) : undefined}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={12} aria-hidden="true" />
            Open in viewer
          </a>
          <button className="lineage-copy-button nodrag" type="button" disabled={!executableSql} onClick={() => void copyExecutableSql()}>
            <Copy size={12} aria-hidden="true" />
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy SQL'}
          </button>
        </div>
      </div>
      <SqlCodeMirror className="lineage-inspector-code" value={displaySql} />
    </section>
  );
}

function ColumnDiagnosticPacketPanel({
  copyState,
  onCopyJson,
  packet,
}: {
  activeInspectorCardId?: string | null;
  activeRoot: boolean;
  copyState: 'idle' | 'copied' | 'failed';
  expandedExpressionColumnIds?: Set<string>;
  expressionExpanded?: boolean;
  hasExpressionBreakdown?: boolean;
  onClearRoot: () => void;
  onCopyJson: () => void;
  onFocusNode?: (nodeId: string) => void;
  onHighlightTarget?: (target: GraphHighlightTarget) => void;
  onSelectInspectorCard?: SelectInspectorCard;
  onToggleColumnExpressionBreakdown?: (columnId: string) => void;
  onToggleRootExpressionBreakdown?: () => void;
  packet: ColumnDiagnosticPacket;
  problemIntent: ProblemIntent;
  rootItem: InspectorColumnItem;
  tree: InspectorColumnTreeNode[];
}) {
  const viewModel = useMemo(() => buildDiagnosticTreeViewModel(packet), [packet]);
  return (
    <section className="lineage-inspector-section lineage-diagnostic-section">
      <div className="lineage-inspector-section-heading">
        <span aria-hidden="true" />
        <button className="lineage-copy-button nodrag" type="button" onClick={onCopyJson}>
          <Copy size={12} aria-hidden="true" />
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy JSON'}
        </button>
      </div>
      <DiagnosticOutputBlock value={viewModel.json} />
    </section>
  );
}

function DiagnosticOutputBlock({
  value,
}: {
  value: string;
}) {
  return (
    <div className="lineage-diagnostic-output">
      <pre className="lineage-diagnostic-output-json">{value}</pre>
    </div>
  );
}

function populationNodeIdsFromPacket(packet: ColumnDiagnosticPacket, problemIntent: ProblemIntent): string[] {
  return Object.keys(populationImpactLabelsByNodeIdFromPacket(packet, problemIntent));
}

function resolvePopulationHighlightContext(
  lineage: LineageModel,
  target: GraphHighlightColumnTarget,
  problemIntent: ProblemIntent,
): Pick<GraphHighlightColumnTarget, 'populationImpactLabelsByNodeId' | 'populationNodeIds' | 'sourceDataLabelsByNodeId' | 'sourceDataNodeIds'> {
  try {
    const packet = buildColumnDiagnosticPacket(lineage, {
      columnName: target.columnName,
      nodeId: target.nodeId,
      scopeId: target.scopeId,
    });
    const impactLabelsByNodeId = populationImpactLabelsByNodeIdFromPacket(packet, problemIntent);
    const sourceDataLabelsByNodeId = sourceDataLabelsByNodeIdFromPacket(packet, problemIntent);
    return {
      populationImpactLabelsByNodeId: impactLabelsByNodeId,
      populationNodeIds: Object.keys(impactLabelsByNodeId),
      sourceDataLabelsByNodeId,
      sourceDataNodeIds: Object.keys(sourceDataLabelsByNodeId),
    };
  } catch {
    return { populationImpactLabelsByNodeId: {}, populationNodeIds: [target.nodeId], sourceDataLabelsByNodeId: {}, sourceDataNodeIds: [] };
  }
}

function populationImpactLabelsByNodeIdFromPacket(packet: ColumnDiagnosticPacket, problemIntent: ProblemIntent): Record<string, string[]> {
  return populationImpactLabelsByNodeIdForIntent(packet, problemIntent);
}

function sourceDataNodeIdsFromPacket(packet: ColumnDiagnosticPacket, problemIntent: ProblemIntent): string[] {
  return Object.keys(sourceDataLabelsByNodeIdFromPacket(packet, problemIntent));
}

function sourceDataLabelsByNodeIdFromPacket(packet: ColumnDiagnosticPacket, problemIntent: ProblemIntent): Record<string, string[]> {
  return sourceDataValueLabelsByNodeIdForIntent(packet, problemIntent);
}

function toNodeImpactLabelMap(record?: Record<string, string[]>): Map<string, string[]> {
  return new Map(Object.entries(record ?? {}).filter(([, labels]) => labels.length > 0));
}

function ProblemIntentSelector({
  intent,
  onChange,
}: {
  intent: ProblemIntent;
  onChange?: (intent: ProblemIntent) => void;
}) {
  return (
    <div className="graph-problem-intent" aria-label="Diagnostic focus">
      <label htmlFor="problem-intent-select">Focus</label>
      <select
        id="problem-intent-select"
        value={intent}
        onChange={(event) => onChange?.(event.currentTarget.value as ProblemIntent)}
      >
        {problemIntentOptions.map((option) => (
          <option key={option} value={option}>
            {problemIntentLabels[option]}
          </option>
        ))}
      </select>
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
      <h3>Sources</h3>
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
  const cardId = inspectorSourceGroupKey(node);
  const active = activeInspectorCardId === cardId;
  const selectGroup = () => onSelectInspectorCard?.(cardId, node.id, { kind: 'nodes', nodeIds: [node.id] });
  return (
    <div
      className={`lineage-inspector-source-group lineage-inspector-source-group-selectable ${active ? 'lineage-inspector-source-group-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={selectGroup}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectGroup();
        }
      }}
    >
      <div className="lineage-inspector-source-heading">
        <InspectorTypeBadge node={node} />
        <span className="lineage-inspector-node-name">{node.label}</span>
      </div>
      <div className="lineage-inspector-source-columns">
        {group.items.map((item, index) => {
          const expressionSql =
            item.column.expressionSql && !isSimpleColumnReference(item.column.expressionSql) ? item.column.expressionSql : undefined;
          return (
            <div
              className="lineage-inspector-source-column"
              key={`${item.column.id}:${index}`}
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
      <h3>Upstream</h3>
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
      {renderNodes.map((entry) => {
        const cardId = `${pathKey ?? 'tree'}/${inspectorTreeEntryKey(entry)}`;
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

function inspectorTreeEntryKey(entry: InspectorColumnTreeRenderEntry) {
  return entry.kind === 'group'
    ? `group:${entry.items[0]?.node.id ?? 'unknown'}:${entry.items.map((item) => item.column.id).join(',')}`
    : inspectorTreeNodeKey(entry.node);
}

function inspectorTreeNodeKey(node: InspectorColumnTreeNode) {
  if (node.kind === 'rule') {
    return `rule:${node.ownerNode.id}:${node.rule.id}`;
  }
  if (node.kind === 'expression') {
    return `expression:${node.ownerNode.id}:${node.expression.kind}:${node.expression.sql}`;
  }
  return `column:${node.item.node.id}:${node.item.column.id}`;
}

function InspectorColumnGroupCard({
  active,
  cardId,
  items,
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
        <span className="lineage-inspector-node-name">{node.label}</span>
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
  const groupDetails = collectInspectorGroupDetails(item);
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
        <span className="lineage-inspector-node-name">{item.node.label}</span>
      </div>
      <span className="lineage-inspector-column-name">{item.column.name}</span>
      {item.column.comments?.length ? <div className="lineage-inspector-card-note">{item.column.comments.join(' ')}</div> : null}
      {showUsage && item.column.usage ? <div className="lineage-inspector-card-note">{formatInspectorUsage(item.column)}</div> : null}
      {expressionSql ? <SqlCodeMirror className="lineage-inspector-inline-code" value={expressionSql} /> : null}
      {item.column.unresolvedUpstream?.length ? <UnresolvedUpstreamNotice column={item.column} lineage={item.lineage} /> : null}
      {groupDetails ? <InspectorGroupDetails details={groupDetails} /> : null}
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

function UnresolvedUpstreamNotice({ column, lineage }: { column: LineageColumn; lineage?: LineageModel }) {
  return (
    <div className="lineage-inspector-deadlink">
      <div className="lineage-inspector-deadlink-title">Unresolved upstream</div>
      {column.unresolvedUpstream?.map((item, index) => (
        <div className="lineage-inspector-deadlink-item" key={`${item.reason}:${item.sql}:${index}`}>
          <code>{item.sql}</code>
          <span>{formatUnresolvedReason(item, lineage)}</span>
          <small>{item.suggestion}</small>
        </div>
      ))}
    </div>
  );
}

function formatUnresolvedReason(item: NonNullable<LineageColumn['unresolvedUpstream']>[number], lineage?: LineageModel): string {
  if (item.reason === 'unknown_qualified_source') {
    return 'The qualifier is not defined in this SELECT scope.';
  }
  if (item.reason === 'ambiguous_unqualified_column') {
    const candidates = formatCandidateNodeLabels(item.candidateNodeIds, lineage);
    return candidates ? `The unqualified column matches multiple sources: ${candidates}.` : 'The unqualified column matches multiple sources.';
  }
  const candidates = formatCandidateNodeLabels(item.candidateNodeIds, lineage);
  return candidates
    ? `The source is unknown across available sources: ${candidates}.`
    : 'The source is unknown. DDL/schema facts or an explicit qualifier may be required.';
}

function formatCandidateNodeLabels(candidateNodeIds: string[] | undefined, lineage?: LineageModel): string | undefined {
  if (!candidateNodeIds || candidateNodeIds.length === 0) {
    return undefined;
  }
  const nodesById = new Map(lineage?.nodes.map((node) => [node.id, node.label]) ?? []);
  return candidateNodeIds.map((nodeId) => nodesById.get(nodeId) ?? nodeId).join(', ');
}

function InspectorGroupDetails({ details }: { details: { grainSql?: string; inputSql?: string } }) {
  return (
    <div className="lineage-inspector-group-details">
      {details.inputSql ? (
        <pre className="lineage-inspector-group-sql">{details.inputSql}</pre>
      ) : null}
      {details.grainSql ? (
        <pre className="lineage-inspector-group-sql">{details.grainSql}</pre>
      ) : null}
    </div>
  );
}

function collectInspectorGroupDetails(item: InspectorColumnItem): { grainSql?: string; inputSql?: string } | null {
  if (!item.lineage || !item.node.dependencyProfile?.hasGroupBy) {
    return null;
  }

  const scopeIds = new Set(item.node.dependencyProfile.scopeIds);
  const grain = uniqueStrings(item.lineage.scopes
    .filter((scope) => scopeIds.has(scope.id))
    .flatMap((scope) => scope.groupBy ?? [])
    .map((expression) => expression.expressionSql));
  const nodesById = new Map(item.lineage.nodes.map((node) => [node.id, node]));
  const inputNodeIds = new Set(item.node.dependencyProfile.inputNodeIds);
  const incomingInputEdges = item.lineage.edges.filter((edge) => edge.target === item.node.id && inputNodeIds.has(edge.source));
  const inputEdgeBySourceId = new Map(incomingInputEdges.map((edge) => [edge.source, edge]));
  const inputs = uniqueStrings(item.node.dependencyProfile.inputNodeIds
    .map((nodeId) => formatInputSourceSql(nodesById.get(nodeId), inputEdgeBySourceId.get(nodeId)))
    .filter((label): label is string => Boolean(label)));
  const grainSql = formatSqlList('group by', grain);
  const inputSql = formatSqlList('from', inputs);

  return grainSql || inputSql ? { grainSql, inputSql } : null;
}

function formatInputSourceSql(node?: LineageNode, edge?: LineageEdge): string | undefined {
  if (!node) {
    return undefined;
  }
  const alias = edge?.sourceAlias?.trim();
  if (!alias || sameIdentifier(alias, node.label)) {
    return node.label;
  }
  return `${node.label} as ${alias}`;
}

function formatSqlList(prefix: string, values: string[]) {
  if (!values.length) {
    return undefined;
  }
  return `${prefix} ${values.join(', ')}`;
}

function sameIdentifier(left: string, right: string): boolean {
  return left.replace(/["`[\]]/g, '').toLowerCase() === right.replace(/["`[\]]/g, '').toLowerCase();
}

function inspectorItemKey(item: InspectorColumnItem) {
  return `${item.node.id}:${item.column.id}`;
}

function inspectorItemToHighlightColumn(item: InspectorColumnItem, upstreamRefs?: LineageColumnRef[]): GraphHighlightColumnTarget {
  return {
    columnId: item.column.id,
    columnName: item.column.name,
    nodeId: item.node.id,
    scopeId: item.column.scopeId,
    upstreamRefs,
  };
}

function inspectorSourceGroupKey(node: LineageNode) {
  return `source:${node.id}`;
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

function hideParameterNodesForGraph(lineage: LineageModel): LineageModel {
  const parameterNodeIds = new Set(lineage.nodes.filter((node) => node.type === 'parameter_table').map((node) => node.id));
  if (parameterNodeIds.size === 0) {
    return lineage;
  }
  return {
    ...lineage,
    nodes: lineage.nodes.filter((node) => !parameterNodeIds.has(node.id)),
    edges: lineage.edges.filter((edge) => !parameterNodeIds.has(edge.source) && !parameterNodeIds.has(edge.target)),
  };
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
  const type = node.recursive ? 'recursive' : isUnionNode(node) ? 'union' : node.type;
  return <span className={`lineage-inspector-type lineage-inspector-type-${type}`}>{formatInspectorTypeLabel(type)}</span>;
}

function formatInspectorTypeLabel(type: LineageNode['type'] | 'recursive' | 'union'): string {
  if (type === 'parameter_table') return 'PARAM';
  if (type === 'scalar_subquery') return 'SCALAR';
  return type.toUpperCase();
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
  lineage: LineageModel,
  selectedColumn: SelectedColumn,
  expandedExpressionColumnIds: Set<string>,
  upstreamRefs?: LineageColumnRef[],
): Extract<InspectorSelection, { kind: 'column' }> | null {
  const nodes = lineage.nodes;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const selectedNode = nodesById.get(selectedColumn.nodeId);
  const selected = selectedNode?.columns.find((column) => column.id === selectedColumn.columnId);
  if (!selectedNode || !selected) {
    return null;
  }

  const downstreamByColumnKey = buildDownstreamColumnIndex(nodes);
  const initialUpstreamRefs = upstreamRefs ?? selected.upstream ?? [];
  const upstream = collectUpstreamColumns(nodesById, lineage, selectedNode.id, selected.name, initialUpstreamRefs);
  const downstream = collectDownstreamColumns(nodesById, lineage, downstreamByColumnKey, selectedNode.id, selected.name);
  const hasExpressionBreakdown = Boolean(selected.caseRules?.length || selected.expressionTree);
  const expressionExpanded = expandedExpressionColumnIds.has(selected.id);
  const upstreamTree =
    expressionExpanded && (selected.caseRules?.length || selected.expressionTree) && !upstreamRefs
      ? collectExpressionBreakdownTree(nodesById, lineage, selectedNode, selected, expandedExpressionColumnIds)
      : collectUpstreamColumnTree(nodesById, lineage, selectedNode.id, selected.name, expandedExpressionColumnIds, initialUpstreamRefs);
  const downstreamTree = collectDownstreamColumnTree(nodesById, lineage, downstreamByColumnKey, selectedNode.id, selected.name);
  const sources = upstream.filter((item) => (item.column.upstream ?? []).length === 0);
  return {
    kind: 'column',
    selected: createInspectorColumnItem(lineage, selectedNode, selected),
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
  lineage: LineageModel,
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
      result.push(createInspectorColumnItem(lineage, upstreamNode, upstreamColumn));
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
      result.push(createInspectorColumnItem(lineage, upstreamNode, upstreamColumn));
      visit(ref.nodeId, ref.columnName);
    }
  } else {
    visit(nodeId, columnName);
  }
  return result;
}

function collectUpstreamColumnTree(
  nodesById: Map<string, LineageNode>,
  lineage: LineageModel,
  nodeId: string,
  columnName: string,
  expandedExpressionColumnIds: Set<string>,
  upstreamRefs?: LineageColumnRef[],
): InspectorColumnTreeNode[] {
  if (upstreamRefs) {
    return upstreamRefs
      .map((ref) => buildUpstreamColumnTreeNode(nodesById, lineage, ref, new Set([columnKey(nodeId, columnName)]), expandedExpressionColumnIds))
      .filter(isInspectorTreeNode);
  }

  const node = nodesById.get(nodeId);
  const column = node?.columns.find((item) => item.name === columnName);
  return (column?.upstream ?? [])
    .map((ref) => buildUpstreamColumnTreeNode(nodesById, lineage, ref, new Set([columnKey(nodeId, columnName)]), expandedExpressionColumnIds))
    .filter(isInspectorTreeNode);
}

function collectCaseRuleUpstreamTree(
  nodesById: Map<string, LineageNode>,
  lineage: LineageModel,
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
      .map((ref) => buildUpstreamColumnTreeNode(nodesById, lineage, ref, rootPath, expandedExpressionColumnIds))
      .filter(isInspectorTreeNode),
    item: createInspectorColumnItem(lineage, ownerNode, ownerColumn),
    kind: 'rule' as const,
    ownerNode,
    rule,
  }));
}

function collectExpressionBreakdownTree(
  nodesById: Map<string, LineageNode>,
  lineage: LineageModel,
  ownerNode: LineageNode,
  column: LineageColumn,
  expandedExpressionColumnIds: Set<string>,
): InspectorColumnTreeNode[] {
  if (column.caseRules?.length) {
    return collectCaseRuleUpstreamTree(nodesById, lineage, ownerNode.id, column.name, column.caseRules, expandedExpressionColumnIds);
  }

  if (column.expressionTree) {
    return [buildExpressionTreeNode(nodesById, lineage, ownerNode, column.expressionTree, new Set([columnKey(ownerNode.id, column.name)]), expandedExpressionColumnIds)];
  }

  return [];
}

function buildExpressionTreeNode(
  nodesById: Map<string, LineageNode>,
  lineage: LineageModel,
  ownerNode: LineageNode,
  expression: LineageExpressionTree,
  path: Set<string>,
  expandedExpressionColumnIds: Set<string>,
): InspectorColumnTreeNode {
  if (expression.kind === 'column') {
    const resolvedColumn = buildUpstreamColumnTreeNode(nodesById, lineage, expression.ref, path, expandedExpressionColumnIds);
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
        ? expression.children
            .map((child) => buildExpressionChildTreeNode(nodesById, lineage, ownerNode, child, path, expandedExpressionColumnIds))
            .filter(isInspectorTreeNode)
        : expression.upstream.map((ref) => buildUpstreamColumnTreeNode(nodesById, lineage, ref, path, expandedExpressionColumnIds)).filter(isInspectorTreeNode),
    expression,
    kind: 'expression',
    ownerNode,
  };
}

function createInspectorColumnItem(lineage: LineageModel, node: LineageNode, column: LineageColumn): InspectorColumnItem {
  return { column, lineage, node };
}

function buildExpressionChildTreeNode(
  nodesById: Map<string, LineageNode>,
  lineage: LineageModel,
  ownerNode: LineageNode,
  expression: LineageExpressionTree,
  path: Set<string>,
  expandedExpressionColumnIds: Set<string>,
): InspectorColumnTreeNode | null {
  if (expression.kind === 'column') {
    return buildUpstreamColumnTreeNode(nodesById, lineage, expression.ref, path, expandedExpressionColumnIds) ?? buildExpressionTreeNode(nodesById, lineage, ownerNode, expression, path, expandedExpressionColumnIds);
  }
  return buildExpressionTreeNode(nodesById, lineage, ownerNode, expression, path, expandedExpressionColumnIds);
}

function buildUpstreamColumnTreeNode(
  nodesById: Map<string, LineageNode>,
  lineage: LineageModel,
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
    return { children: [], item: createInspectorColumnItem(lineage, upstreamNode, upstreamColumn), kind: 'column' };
  }

  const nextPath = new Set(path);
  nextPath.add(key);
  const expressionChildren =
    expandedExpressionColumnIds.has(upstreamColumn.id) && (upstreamColumn.caseRules?.length || upstreamColumn.expressionTree)
      ? collectExpressionBreakdownTree(nodesById, lineage, upstreamNode, upstreamColumn, expandedExpressionColumnIds)
      : null;
  return {
    children:
      expressionChildren ??
      (upstreamColumn.upstream ?? [])
        .map((childRef) => buildUpstreamColumnTreeNode(nodesById, lineage, childRef, nextPath, expandedExpressionColumnIds))
        .filter(isInspectorTreeNode),
    item: createInspectorColumnItem(lineage, upstreamNode, upstreamColumn),
    kind: 'column',
  };
}

function collectDownstreamColumns(
  nodesById: Map<string, LineageNode>,
  lineage: LineageModel,
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
      result.push(createInspectorColumnItem(lineage, downstreamNode, downstreamColumn));
      visit(ref.nodeId, ref.columnName);
    }
  };

  visit(nodeId, columnName);
  return result;
}

function collectDownstreamColumnTree(
  nodesById: Map<string, LineageNode>,
  lineage: LineageModel,
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
      return { children: [], item: createInspectorColumnItem(lineage, downstreamNode, downstreamColumn), kind: 'column' };
    }

    const nextPath = new Set(path);
    nextPath.add(key);
    return {
      children: (downstreamByColumnKey.get(key) ?? []).map((childRef) => buildNode(childRef, nextPath)).filter(isInspectorTreeNode),
      item: createInspectorColumnItem(lineage, downstreamNode, downstreamColumn),
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
  selectedColumn: GraphHighlightColumnTarget,
  upstreamRefs?: LineageColumnRef[],
): GraphHighlightResult {
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
  return {
    edgeTone: 'value',
    highlightedColumnIds,
    highlightedEdgeIds,
    highlightedNodeImpactLabels: toNodeImpactLabelMap(selectedColumn.populationImpactLabelsByNodeId),
    highlightedNodeIds: new Set(selectedColumn.populationNodeIds ?? []),
    highlightedSourceDataLabels: toNodeImpactLabelMap(selectedColumn.sourceDataLabelsByNodeId),
    highlightedSourceDataNodeIds: new Set(selectedColumn.sourceDataNodeIds ?? []),
    nodeTone: 'population',
    sourceColumnIds,
  };
}

interface GraphHighlightResult {
  edgeTone: 'population' | 'value';
  highlightedColumnIds: Set<string>;
  highlightedEdgeIds: Set<string>;
  highlightedNodeImpactLabels: Map<string, string[]>;
  highlightedNodeIds: Set<string>;
  highlightedSourceDataLabels: Map<string, string[]>;
  highlightedSourceDataNodeIds: Set<string>;
  nodeTone: 'population' | 'value';
  sourceColumnIds: Set<string>;
}

function resolveHighlightTarget(
  nodes: LineageNode[],
  edges: LineageEdge[],
  target: GraphHighlightTarget,
): GraphHighlightResult {
  const empty: GraphHighlightResult = {
    edgeTone: 'value' as const,
    highlightedColumnIds: new Set<string>(),
    highlightedEdgeIds: new Set<string>(),
    highlightedNodeImpactLabels: new Map<string, string[]>(),
    highlightedNodeIds: new Set<string>(),
    highlightedSourceDataLabels: new Map<string, string[]>(),
    highlightedSourceDataNodeIds: new Set<string>(),
    nodeTone: 'value' as const,
    sourceColumnIds: new Set<string>(),
  };
  if (!target) {
    return empty;
  }

  if (target.kind === 'nodes') {
    const highlightedNodeIds = new Set(target.nodeIds);
    const highlightedEdgeIds = new Set<string>();
    for (const edge of edges) {
      if (edge.type !== 'dataFlow') {
        continue;
      }
      if (highlightedNodeIds.has(edge.source) && highlightedNodeIds.has(edge.target)) {
        highlightedEdgeIds.add(edge.id);
      }
    }
    return {
      ...empty,
      edgeTone: 'population',
      highlightedEdgeIds,
      highlightedNodeIds,
      highlightedNodeImpactLabels: toNodeImpactLabelMap(target.populationImpactLabelsByNodeId),
      highlightedSourceDataLabels: toNodeImpactLabelMap(target.sourceDataLabelsByNodeId),
      highlightedSourceDataNodeIds: new Set(Object.keys(target.sourceDataLabelsByNodeId ?? {})),
      nodeTone: 'population',
    };
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
    for (const nodeId of highlights.highlightedNodeIds) {
      merged.highlightedNodeIds.add(nodeId);
    }
    for (const [nodeId, labels] of highlights.highlightedNodeImpactLabels) {
      const mergedLabels = new Set(merged.highlightedNodeImpactLabels.get(nodeId) ?? []);
      for (const label of labels) {
        mergedLabels.add(label);
      }
      merged.highlightedNodeImpactLabels.set(nodeId, [...mergedLabels]);
    }
    for (const nodeId of highlights.highlightedSourceDataNodeIds) {
      merged.highlightedSourceDataNodeIds.add(nodeId);
    }
    for (const [nodeId, labels] of highlights.highlightedSourceDataLabels) {
      const mergedLabels = new Set(merged.highlightedSourceDataLabels.get(nodeId) ?? []);
      for (const label of labels) {
        mergedLabels.add(label);
      }
      merged.highlightedSourceDataLabels.set(nodeId, [...mergedLabels]);
    }
    for (const columnId of highlights.sourceColumnIds) {
      merged.sourceColumnIds.add(columnId);
    }
    if (highlights.highlightedNodeIds.size > 0) {
      merged.nodeTone = 'population';
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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

function createAutoCollapsedGroupRootIds(
  groups: Map<string, { helperNodeIds: string[] }>,
  expandedNodeId: string | null,
  edges: LineageEdge[],
) {
  const rootIds = new Set(groups.keys());
  if (expandedNodeId) {
    rootIds.delete(expandedNodeId);
    for (const downstreamGroupRootId of collectDownstreamGroupRootIds(expandedNodeId, groups, edges)) {
      rootIds.delete(downstreamGroupRootId);
    }
    for (const [rootNodeId, group] of groups) {
      if (group.helperNodeIds.includes(expandedNodeId)) {
        rootIds.delete(rootNodeId);
      }
    }
  }

  for (const rootNodeId of [...rootIds]) {
    for (const [ancestorRootId, group] of groups) {
      if (ancestorRootId !== rootNodeId && rootIds.has(ancestorRootId) && group.helperNodeIds.includes(rootNodeId)) {
        rootIds.delete(rootNodeId);
        break;
      }
    }
  }

  return rootIds;
}

function collectDownstreamGroupRootIds(
  startNodeId: string,
  groups: Map<string, { helperNodeIds: string[] }>,
  edges: LineageEdge[],
) {
  const downstreamGroupRootIds = new Set<string>();
  const visitedNodeIds = new Set<string>([startNodeId]);
  const queue = [startNodeId];

  while (queue.length > 0) {
    const currentNodeId = queue.shift();
    if (!currentNodeId) {
      continue;
    }

    for (const edge of edges) {
      if (edge.type !== 'dataFlow' || edge.source !== currentNodeId) {
        continue;
      }

      const nextNodeId = edge.target;
      if (groups.has(nextNodeId)) {
        downstreamGroupRootIds.add(nextNodeId);
      }
      if (!visitedNodeIds.has(nextNodeId)) {
        visitedNodeIds.add(nextNodeId);
        queue.push(nextNodeId);
      }
    }
  }

  return downstreamGroupRootIds;
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

function getColumnScopeSql(lineage: LineageModel, scopeId: string | undefined, nodeId: string): string | undefined {
  if (scopeId) {
    const scopeSql = lineage.scopes.find((scope) => scope.id === scopeId)?.querySql;
    if (scopeSql) {
      return scopeSql;
    }
  }
  return lineage.scopes.find((scope) => scope.nodeId === nodeId)?.querySql;
}

function getColumnExecutableSql(lineage: LineageModel, scopeId: string | undefined, nodeId: string): string | undefined {
  const scopeNodeId = scopeId ? lineage.scopes.find((scope) => scope.id === scopeId)?.nodeId : undefined;
  const node = lineage.nodes.find((item) => item.id === (scopeNodeId ?? nodeId)) ?? lineage.nodes.find((item) => item.id === nodeId);
  if (node) {
    return getNodeSql(node);
  }
  return getColumnScopeSql(lineage, scopeId, nodeId);
}

function buildViewerSqlUrl(sql: string) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = new URLSearchParams({ sql, history: '0' }).toString();
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
