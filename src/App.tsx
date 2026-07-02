import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Code2, Eraser, Info, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pencil, Play, Share2, Trash2, X } from 'lucide-react';
import { LineageGraph, LineageInspector, type CaseRuleSelection, type InspectorCardSelection, type InspectorSelection, type InspectorSelectionChangeReason } from './components/LineageGraph';
import { SqlCodeMirror } from './components/SqlCodeMirror';
import { salesSummarySql } from './examples/salesSummarySql';
import { collectUnreachableCteNodeIds, type GraphFlowDirection } from './graph/buildGraphModel';
import type { AnalysisWarning } from './domain/lineage';
import type { ProblemIntent } from './lineage/problemIntent';
import { analyzeSql } from './lineage/rawsqlAdapter';

const maxShareUrlLength = 8000;
const sqlHistoryStorageKey = 'rawsql-lineage-viewer:sql-history';
const sqlHistorySortStorageKey = 'rawsql-lineage-viewer:sql-history-sort';
const legendPanelStorageKey = 'rawsql-lineage-viewer:legend-panel-open';
const inspectorCardHistoryStateKey = 'rawsqlLineageViewerInspectorCard';
const mobileInspectorHistoryStateKey = 'rawsqlLineageViewerMobileInspector';
const mobileLineageViewportQuery = '(max-width: 860px)';
const maxSqlHistoryItems = 20;
const defaultOutputTitle = 'Final Result';
type SqlHistorySortMode = 'recent' | 'name';

interface SqlHistoryItem {
  id: string;
  openedAt: string;
  outputTitle?: string;
  sql: string;
  title: string;
}

interface WarningCounters {
  cteSql: number;
  undefinedSources: number;
  duplicates: number;
  ddl: number;
  unresolvedColumns: number;
  other: number;
  unsupported: number;
  unusedCtes: number;
  wildcards: number;
}

export function App() {
  const initialSql = useMemo(readInitialSqlFromUrl, []);
  const shouldRecordInitialSql = useMemo(readInitialSqlHistoryEnabledFromUrl, []);
  const initialHistory = useMemo(() => readSqlHistory(initialSql, shouldRecordInitialSql), [initialSql, shouldRecordInitialSql]);
  const isMobileLineageViewport = useMobileLineageViewport();
  const [sql, setSql] = useState(initialSql);
  const [isPanelOpen, setIsPanelOpen] = useState(() => !readIsMobileLineageViewport());
  const [isLegendPanelOpen, setIsLegendPanelOpen] = useState(readLegendPanelOpen);
  const [panelTab, setPanelTab] = useState<'sql' | 'inspector'>('sql');
  const [sqlPanelTab, setSqlPanelTab] = useState<'open' | 'history'>('open');
  const [inspectorSelection, setInspectorSelection] = useState<InspectorSelection>(null);
  const [forcedInspectorSelection, setForcedInspectorSelection] = useState<InspectorSelection>(null);
  const [activeInspectorCardId, setActiveInspectorCardId] = useState<string | null>(null);
  const [activeInspectorCardColumnId, setActiveInspectorCardColumnId] = useState<string | null>(null);
  const [caseRuleSelection, setCaseRuleSelection] = useState<CaseRuleSelection | null>(null);
  const [autoInspectOutputNonce, setAutoInspectOutputNonce] = useState(0);
  const [graphLoadNonce, setGraphLoadNonce] = useState(0);
  const [expandedExpressionColumnIds, setExpandedExpressionColumnIds] = useState<Set<string>>(() => new Set());
  const [graphFocusTarget, setGraphFocusTarget] = useState<{ nonce: number; nodeId: string } | null>(null);
  const [problemIntent, setProblemIntent] = useState<ProblemIntent>('logic_review');
  const [lastAnalyzedSql, setLastAnalyzedSql] = useState(initialSql);
  const [sqlHistory, setSqlHistory] = useState<SqlHistoryItem[]>(initialHistory);
  const [outputTitle, setOutputTitle] = useState(() => findSqlHistoryOutputTitle(initialSql, initialHistory) ?? defaultOutputTitle);
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied' | 'too-long' | 'failed'>('idle');
  const flowDirection: GraphFlowDirection = 'upstream';
  const lastHandledAutoInspectOutputNonceRef = useRef(0);
  const pendingAutoInspectOutputNonceRef = useRef<number | null>(null);
  const suppressNullInspectorSelectionRef = useRef(false);
  const lastCommittedInspectorCardRef = useRef<InspectorCardSelection | null>(null);
  const lastCommittedMobileInspectorOpenRef = useRef(false);

  const analysis = useMemo(() => {
    try {
      return {
        result: analyzeSql(lastAnalyzedSql),
        error: null,
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        result: null,
        error: message,
      };
    }
  }, [lastAnalyzedSql]);

  const error = analysis.error;
  const adapterResult = analysis.result;
  useEffect(() => {
    if (isMobileLineageViewport) {
      setIsPanelOpen(false);
    }
  }, [isMobileLineageViewport]);
  useEffect(() => {
    if (lastHandledAutoInspectOutputNonceRef.current === autoInspectOutputNonce) {
      return;
    }

    if (!adapterResult) {
      if (pendingAutoInspectOutputNonceRef.current === autoInspectOutputNonce) {
        pendingAutoInspectOutputNonceRef.current = null;
        suppressNullInspectorSelectionRef.current = false;
        setForcedInspectorSelection(null);
        setInspectorSelection(null);
      }
      return;
    }

    lastHandledAutoInspectOutputNonceRef.current = autoInspectOutputNonce;
    const outputNode = adapterResult.lineage.nodes.find((node) => node.type === 'output');
    if (!outputNode) {
      pendingAutoInspectOutputNonceRef.current = null;
      return;
    }

    pendingAutoInspectOutputNonceRef.current = null;
    setForcedInspectorSelection({ kind: 'node', node: { ...outputNode, label: outputTitle } });
    setInspectorSelection({ kind: 'node', node: { ...outputNode, label: outputTitle } });
    if (!isMobileLineageViewport) {
      setIsPanelOpen(true);
      setPanelTab('inspector');
    }
  }, [adapterResult, autoInspectOutputNonce, isMobileLineageViewport, outputTitle]);
  const shareMessage =
    shareStatus === 'copied'
      ? 'Share URL copied'
      : shareStatus === 'too-long'
        ? 'SQL is too long for a share URL'
        : shareStatus === 'failed'
          ? 'Could not copy share URL'
          : null;

  const graphStats = adapterResult
    ? {
        tables: adapterResult.lineage.nodes.filter((node) => node.type === 'table').length,
        ctes: adapterResult.lineage.nodes.filter((node) => node.type === 'cte').length,
        derived: adapterResult.lineage.nodes.filter((node) => node.type === 'derived').length,
        scalarSubqueries: adapterResult.lineage.nodes.filter((node) => node.type === 'scalar_subquery').length,
        parameters: adapterResult.lineage.nodes.filter((node) => node.type === 'parameter_table').length,
        outputs: adapterResult.lineage.nodes.filter((node) => node.type === 'output').length,
        dataFlows: adapterResult.lineage.edges.filter((edge) => edge.type === 'dataFlow').length,
        warnings: summarizeAnalysisWarnings(adapterResult.lineage.analysisWarnings, collectUnreachableCteNodeIds(adapterResult.lineage).size),
      }
    : null;
  useEffect(() => {
    writeLegendPanelOpen(isLegendPanelOpen);
  }, [isLegendPanelOpen]);
  const applyMobileInspectorHistoryState = useCallback((isOpen: boolean) => {
    lastCommittedMobileInspectorOpenRef.current = isOpen;
    if (!isMobileLineageViewport) {
      return;
    }
    if (isOpen) {
      setIsPanelOpen(true);
      setPanelTab('inspector');
    } else {
      setIsPanelOpen(false);
    }
  }, [isMobileLineageViewport]);
  const commitMobileInspectorHistory = useCallback((isOpen: boolean, mode: 'push' | 'replace' = 'push') => {
    if (typeof window === 'undefined') {
      return;
    }
    if (mode === 'push' && lastCommittedMobileInspectorOpenRef.current === isOpen) {
      return;
    }

    const currentState = isRecord(window.history.state) ? window.history.state : {};
    const nextState = { ...currentState };
    if (isOpen) {
      nextState[mobileInspectorHistoryStateKey] = true;
    } else {
      delete nextState[mobileInspectorHistoryStateKey];
    }

    if (mode === 'replace') {
      window.history.replaceState(nextState, '', window.location.href);
    } else {
      window.history.pushState(nextState, '', window.location.href);
    }
    lastCommittedMobileInspectorOpenRef.current = isOpen;
  }, []);
  const handleInspectorSelectionChange = useCallback((selection: InspectorSelection, reason: InspectorSelectionChangeReason = 'sync') => {
    if (selection && !(selection.kind === 'node' && selection.node.type === 'output')) {
      setForcedInspectorSelection(null);
    }
    setInspectorSelection((current) => {
      if (!selection && (pendingAutoInspectOutputNonceRef.current !== null || suppressNullInspectorSelectionRef.current)) {
        return current;
      }
      if (selection) {
        suppressNullInspectorSelectionRef.current = false;
      }
      if (!isSameInspectorSelection(current, selection)) {
        setCaseRuleSelection(null);
        setActiveInspectorCardId(null);
        setActiveInspectorCardColumnId(null);
        lastCommittedInspectorCardRef.current = null;
      }
      return selection;
    });
    const shouldOpenInspector = selection && (
      !isMobileLineageViewport ||
      reason === 'graph-column-selection' ||
      reason === 'graph-node-inspection'
    );
    if (shouldOpenInspector) {
      if (isMobileLineageViewport) {
        commitMobileInspectorHistory(true);
      }
      setIsPanelOpen(true);
      setPanelTab('inspector');
    }
  }, [commitMobileInspectorHistory, isMobileLineageViewport]);
  const applyInspectorCardSelection = useCallback((selection: InspectorCardSelection | null) => {
    setActiveInspectorCardId(selection?.cardId ?? null);
    setActiveInspectorCardColumnId(selection?.columnId ?? null);
    if (!selection) {
      return;
    }
    if (selection.focusNodeId) {
      setGraphFocusTarget({ nodeId: selection.focusNodeId, nonce: Date.now() });
    }
  }, []);
  const commitInspectorCardHistory = useCallback((selection: InspectorCardSelection | null, mode: 'push' | 'replace' = 'push') => {
    if (typeof window === 'undefined') {
      return;
    }
    if (mode === 'push' && isSameInspectorCardSelection(lastCommittedInspectorCardRef.current, selection)) {
      return;
    }

    const currentState = isRecord(window.history.state) ? window.history.state : {};
    const nextState = { ...currentState };
    if (selection) {
      nextState[inspectorCardHistoryStateKey] = selection;
    } else {
      delete nextState[inspectorCardHistoryStateKey];
    }

    if (mode === 'replace') {
      window.history.replaceState(nextState, '', window.location.href);
    } else {
      window.history.pushState(nextState, '', window.location.href);
    }
    lastCommittedInspectorCardRef.current = selection;
  }, []);
  const selectInspectorCard = useCallback((selection: InspectorCardSelection) => {
    commitInspectorCardHistory(selection);
    applyInspectorCardSelection(selection);
  }, [applyInspectorCardSelection, commitInspectorCardHistory]);
  const clearInspectorCard = useCallback((recordHistory = false) => {
    if (recordHistory) {
      commitInspectorCardHistory(null);
    } else {
      lastCommittedInspectorCardRef.current = null;
    }
    applyInspectorCardSelection(null);
  }, [applyInspectorCardSelection, commitInspectorCardHistory]);
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const currentSelection = readInspectorCardHistoryState(window.history.state);
    const currentMobileInspectorOpen = readMobileInspectorHistoryState(window.history.state);
    lastCommittedInspectorCardRef.current = currentSelection;
    lastCommittedMobileInspectorOpenRef.current = currentMobileInspectorOpen;
    applyInspectorCardSelection(currentSelection);
    applyMobileInspectorHistoryState(currentMobileInspectorOpen);

    const handlePopState = (event: PopStateEvent) => {
      const selection = readInspectorCardHistoryState(event.state);
      const mobileInspectorOpen = readMobileInspectorHistoryState(event.state);
      lastCommittedInspectorCardRef.current = selection;
      lastCommittedMobileInspectorOpenRef.current = mobileInspectorOpen;
      applyInspectorCardSelection(selection);
      applyMobileInspectorHistoryState(mobileInspectorOpen);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [applyInspectorCardSelection, applyMobileInspectorHistoryState]);
  const toggleExpressionBreakdown = useCallback((columnId: string) => {
    setCaseRuleSelection(null);
    setExpandedExpressionColumnIds((current) => {
      const next = new Set(current);
      if (next.has(columnId)) {
        next.delete(columnId);
      } else {
        next.add(columnId);
      }
      return next;
    });
  }, []);
  const openSql = useCallback((nextSql: string, nextOutputTitle?: string) => {
    const normalizedSql = nextSql.trim();
    const resolvedOutputTitle = nextOutputTitle ?? findSqlHistoryOutputTitle(normalizedSql, sqlHistory) ?? defaultOutputTitle;
    let nextInspectorSelection: InspectorSelection = null;
    suppressNullInspectorSelectionRef.current = true;
    try {
      const nextAnalysis = analyzeSql(nextSql);
      const outputNode = nextAnalysis.lineage.nodes.find((node) => node.type === 'output');
      if (outputNode) {
        nextInspectorSelection = { kind: 'node', node: { ...outputNode, label: resolvedOutputTitle } };
      }
    } catch {
      nextInspectorSelection = null;
    }

    setSql(nextSql);
    setLastAnalyzedSql(nextSql);
    setGraphLoadNonce((current) => current + 1);
    setCaseRuleSelection(null);
    setActiveInspectorCardId(null);
    setActiveInspectorCardColumnId(null);
    lastCommittedInspectorCardRef.current = null;
    setExpandedExpressionColumnIds(new Set());
    setGraphFocusTarget(null);
    setForcedInspectorSelection(nextInspectorSelection);
    setInspectorSelection(nextInspectorSelection);
    setShareStatus('idle');
    setAutoInspectOutputNonce((current) => {
      const next = current + 1;
      pendingAutoInspectOutputNonceRef.current = next;
      suppressNullInspectorSelectionRef.current = true;
      return next;
    });
    setOutputTitle(resolvedOutputTitle);
    setSqlHistory((current) => saveSqlHistory(nextSql, current));
    if (isMobileLineageViewport) {
      setIsPanelOpen(false);
    } else if (nextInspectorSelection) {
      setIsPanelOpen(true);
      setPanelTab('inspector');
    }
  }, [isMobileLineageViewport, sqlHistory]);
  const openHistoryItem = useCallback((item: SqlHistoryItem) => {
    openSql(item.sql, item.outputTitle ?? defaultOutputTitle);
  }, [openSql]);
  const renameOutputTitle = useCallback((title: string) => {
    const normalizedTitle = normalizeSqlHistoryTitle(title, lastAnalyzedSql);
    setOutputTitle(normalizedTitle);
    setForcedInspectorSelection((current) =>
      current?.kind === 'node' && current.node.type === 'output'
        ? { ...current, node: { ...current.node, label: normalizedTitle } }
        : current,
    );
    setInspectorSelection((current) =>
      current?.kind === 'node' && current.node.type === 'output'
        ? { ...current, node: { ...current.node, label: normalizedTitle } }
        : current,
    );
    setSqlHistory((current) => {
      const next = upsertSqlHistoryTitle(lastAnalyzedSql, normalizedTitle, current);
      writeSqlHistory(next);
      return next;
    });
  }, [lastAnalyzedSql]);
  const deleteOutputTitle = useCallback(() => {
    const normalizedSql = lastAnalyzedSql.trim();
    setSql('');
    setLastAnalyzedSql('');
    setOutputTitle(defaultOutputTitle);
    setPanelTab('sql');
    setIsPanelOpen(true);
    setCaseRuleSelection(null);
    setActiveInspectorCardId(null);
    setActiveInspectorCardColumnId(null);
    lastCommittedInspectorCardRef.current = null;
    setExpandedExpressionColumnIds(new Set());
    setGraphFocusTarget(null);
    setForcedInspectorSelection(null);
    setInspectorSelection(null);
    setShareStatus('idle');
    pendingAutoInspectOutputNonceRef.current = null;
    setSqlHistory((current) => {
      const next = normalizedSql ? current.filter((item) => item.sql.trim() !== normalizedSql) : current;
      writeSqlHistory(next);
      return next;
    });
  }, [lastAnalyzedSql]);

  const isMobileInspectorActive = isMobileLineageViewport && isPanelOpen && panelTab === 'inspector';
  const isMobilePanelActive = isMobileLineageViewport && isPanelOpen && panelTab !== 'inspector';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <button
            className="icon-button"
            type="button"
            onClick={() => setIsPanelOpen((value) => !value)}
            aria-label={isPanelOpen ? 'Hide SQL panel' : 'Show SQL panel'}
            title={isPanelOpen ? 'Hide SQL panel' : 'Show SQL panel'}
          >
            {isPanelOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <div>
            <h1>SQL Lineage Viewer</h1>
            <p>Paste SQL. See the lineage.</p>
          </div>
        </div>
        <div className="header-actions">
          {shareMessage ? (
            <span className={`share-status share-status-${shareStatus}`} role="status">
              {shareMessage}
            </span>
          ) : null}
          <button className="share-button" type="button" onClick={() => void copyShareUrl(sql, setShareStatus)}>
            <Share2 size={16} />
            <span>Share</span>
          </button>
          <a className="github-link" href="https://github.com/mk3008/rawsql-lineage-viewer" target="_blank" rel="noreferrer">
            <GitHubMark />
            <span>GitHub</span>
          </a>
          <button
            className="icon-button legend-toggle-button"
            type="button"
            onClick={() => setIsLegendPanelOpen((value) => !value)}
            aria-label={isLegendPanelOpen ? 'Hide legend panel' : 'Show legend panel'}
            title={isLegendPanelOpen ? 'Hide legend panel' : 'Show legend panel'}
          >
            {isLegendPanelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
        </div>
      </header>

      <main
        className={`workspace ${isPanelOpen ? '' : 'workspace-panel-collapsed'} ${isLegendPanelOpen ? '' : 'workspace-legend-collapsed'} ${isMobileInspectorActive ? 'workspace-mobile-inspector-active' : ''} ${isMobilePanelActive ? 'workspace-mobile-panel-active' : ''}`}
      >
        <aside className="sql-panel" aria-label="SQL and inspector panel">
          <div className="panel-heading">
            <div className="panel-tabs" role="tablist" aria-label="Side panel">
              <button
                aria-selected={panelTab === 'sql'}
                className={panelTab === 'sql' ? 'active' : ''}
                role="tab"
                type="button"
                onClick={() => setPanelTab('sql')}
              >
                <Code2 size={15} />
                SQL
              </button>
              <button
                aria-selected={panelTab === 'inspector'}
                className={panelTab === 'inspector' ? 'active' : ''}
                role="tab"
                type="button"
                onClick={() => setPanelTab('inspector')}
              >
                <Info size={15} />
                Inspector
              </button>
            </div>
            {isMobileInspectorActive ? (
              <div className="panel-heading-actions">
                <button
                  aria-label="Close inspector"
                  className="panel-close-button"
                  title="Close inspector"
                  type="button"
                  onClick={() => setIsPanelOpen(false)}
                >
                  <X size={18} />
                </button>
              </div>
            ) : null}
          </div>
          {panelTab === 'sql' ? (
            <div className="sql-panel-tabs-layout">
              <div className="panel-subtabs" role="tablist" aria-label="SQL tools">
                <button
                  aria-selected={sqlPanelTab === 'open'}
                  className={sqlPanelTab === 'open' ? 'active' : ''}
                  role="tab"
                  type="button"
                  onClick={() => setSqlPanelTab('open')}
                >
                  <Code2 size={15} />
                  New
                </button>
                <button
                  aria-selected={sqlPanelTab === 'history'}
                  className={sqlPanelTab === 'history' ? 'active' : ''}
                  role="tab"
                  type="button"
                  onClick={() => setSqlPanelTab('history')}
                >
                  <Clock3 size={15} />
                  History
                </button>
              </div>
              {sqlPanelTab === 'open' ? (
                <div className="sql-tab-panel">
                  <div className="sql-editor-actions">
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => {
                        openSql(salesSummarySql);
                      }}
                    >
                      Demo
                    </button>
                    <button
                      aria-label="Clear SQL editor"
                      className="text-button"
                      type="button"
                      disabled={sql.length === 0}
                      onClick={() => {
                        setSql('');
                        setShareStatus('idle');
                      }}
                    >
                      <Eraser size={13} />
                      Clear
                    </button>
                  </div>
                  <div className="sql-editor-frame">
                    <SqlCodeMirror
                      ariaLabel="SQL editor"
                      className="sql-editor"
                      editable
                      minHeight="340px"
                      value={sql}
                      onChange={(value) => {
                        setSql(value);
                        setShareStatus('idle');
                      }}
                    />
                  </div>
                  <div className="panel-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => {
                        openSql(sql);
                      }}
                    >
                      <Play size={15} fill="currentColor" />
                      Analyze SQL
                    </button>
                  </div>
                  <div className={`analysis-status ${error ? 'analysis-status-error' : 'analysis-status-ok'}`} data-testid="analysis-status">
                    {error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
                    <span>{error ? error : 'Parsed successfully'}</span>
                  </div>
                </div>
              ) : (
                <SqlHistoryPanel
                  history={sqlHistory}
                  onClear={() => {
                    setSqlHistory([]);
                    writeSqlHistory([]);
                  }}
                  onOpen={openHistoryItem}
                  onRemove={(id) => {
                    setSqlHistory((current) => {
                      const next = current.filter((item) => item.id !== id);
                      writeSqlHistory(next);
                      return next;
                    });
                  }}
                />
              )}
            </div>
          ) : panelTab === 'inspector' ? (
            adapterResult ? (
              <LineageInspector
                activeInspectorCardId={activeInspectorCardId}
                activeCaseRule={caseRuleSelection}
                expandedExpressionColumnIds={expandedExpressionColumnIds}
                hideColumnDetailTabs={isMobileLineageViewport}
                lineage={adapterResult.lineage}
                onClearCaseRule={() => setCaseRuleSelection(null)}
                onClearInspectorCard={clearInspectorCard}
                onDeleteOutputTitle={deleteOutputTitle}
                onRenameOutputTitle={renameOutputTitle}
                onSelectInspectorCard={selectInspectorCard}
                onToggleExpressionBreakdown={toggleExpressionBreakdown}
                onFocusNode={(nodeId) => {
                  setGraphFocusTarget({ nodeId, nonce: Date.now() });
                }}
                problemIntent={problemIntent}
                selection={forcedInspectorSelection ?? inspectorSelection}
              />
            ) : (
              <div className="lineage-inspector-empty">Analyze SQL to inspect lineage details.</div>
            )
          ) : null}
        </aside>

        <section className="canvas-area">
          {adapterResult ? (
            <>
              <CurrentSqlHeader outputTitle={outputTitle} onDelete={deleteOutputTitle} onRename={renameOutputTitle} />
              <LineageGraph
                key={graphLoadNonce}
                autoInspectOutputNonce={autoInspectOutputNonce}
                caseRuleSelection={caseRuleSelection}
                activeInspectorCardColumnId={activeInspectorCardColumnId}
                expandedExpressionColumnIds={expandedExpressionColumnIds}
                flowDirection={flowDirection}
                focusTarget={graphFocusTarget}
                isGraphViewportVisible={!isMobileInspectorActive && !isMobilePanelActive}
                isMobileGraphDisplayMode={isMobileLineageViewport}
                lineage={adapterResult.lineage}
                onInspectorSelectionChange={handleInspectorSelectionChange}
                onProblemIntentChange={setProblemIntent}
                outputTitle={outputTitle}
                problemIntent={problemIntent}
              />
              <div className="graph-info" data-testid="graph-info">
                <span>Tables <strong>{graphStats?.tables}</strong></span>
                <span>CTEs <strong>{graphStats?.ctes}</strong></span>
                <span>Derived <strong>{graphStats?.derived}</strong></span>
                <span>Scalars <strong>{graphStats?.scalarSubqueries}</strong></span>
                <span>Params <strong>{graphStats?.parameters}</strong></span>
                <span>Output <strong>{graphStats?.outputs}</strong></span>
                <span>DataFlow <strong>{graphStats?.dataFlows}</strong></span>
                <GraphInfoWarningCount
                  label="Unresolved columns"
                  title="Column references that are syntactically valid but cannot be traced without schema facts or explicit qualification."
                  value={graphStats?.warnings.unresolvedColumns ?? 0}
                />
                <GraphInfoWarningCount
                  label="Undefined aliases"
                  title="Qualified references whose table alias or source name is not defined in this SELECT scope."
                  value={graphStats?.warnings.undefinedSources ?? 0}
                />
                <GraphInfoWarningCount
                  label="Unused CTEs"
                  title="CTEs defined in the SQL but not reached from the output graph."
                  value={graphStats?.warnings.unusedCtes ?? 0}
                />
                <GraphInfoWarningCount
                  label="Wildcards"
                  title="Wildcard output columns whose concrete column list could not be inferred."
                  value={graphStats?.warnings.wildcards ?? 0}
                />
                <GraphInfoWarningCount
                  label="DDL parse"
                  title="Warnings while parsing optional DDL/schema facts, for example unsupported CREATE/ALTER syntax."
                  value={graphStats?.warnings.ddl ?? 0}
                />
                <GraphInfoWarningCount
                  label="Unsupported SQL"
                  title="SQL statements or source shapes that the lineage model cannot analyze yet."
                  value={graphStats?.warnings.unsupported ?? 0}
                />
                <GraphInfoWarningCount
                  label="Wildcard duplicates"
                  title="Duplicate column names detected while expanding wildcard outputs from schema facts."
                  value={graphStats?.warnings.duplicates ?? 0}
                />
                <GraphInfoWarningCount
                  label="SQL extract"
                  title="Warnings while extracting executable standalone SQL for CTEs, derived queries, or subqueries."
                  value={graphStats?.warnings.cteSql ?? 0}
                />
                <GraphInfoWarningCount
                  label="Other warnings"
                  title="Warnings that do not fit the named categories."
                  value={graphStats?.warnings.other ?? 0}
                />
              </div>
            </>
          ) : (
            <div className="empty-graph" role="alert">
              <AlertTriangle size={24} />
              <strong>SQL could not be parsed.</strong>
              <span>Fix the SQL and run Analyze SQL again.</span>
            </div>
          )}
        </section>
        {isLegendPanelOpen ? <LegendPanel /> : null}
      </main>
    </div>
  );
}

function GraphInfoWarningCount({ label, title, value }: { label: string; title: string; value: number }) {
  if (value === 0) {
    return null;
  }

  return (
    <span className="graph-info-warning" title={title}>
      {label} <strong>{value}</strong>
    </span>
  );
}

function CurrentSqlHeader({
  outputTitle,
  onDelete,
  onRename,
}: {
  outputTitle: string;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [draftTitle, setDraftTitle] = useState(outputTitle);

  useEffect(() => {
    if (!isEditing) {
      setDraftTitle(outputTitle);
    }
  }, [isEditing, outputTitle]);
  useEffect(() => {
    setIsConfirmingDelete(false);
  }, [outputTitle]);

  const saveTitle = () => {
    onRename(draftTitle);
    setIsEditing(false);
  };
  const cancelEdit = () => {
    setDraftTitle(outputTitle);
    setIsEditing(false);
  };
  const requestDelete = () => {
    if (!isConfirmingDelete) {
      setIsConfirmingDelete(true);
      return;
    }
    onDelete();
    setIsConfirmingDelete(false);
  };
  const cancelDeleteOnOtherClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!isConfirmingDelete) {
      return;
    }
    if ((event.target as HTMLElement).closest('[data-current-sql-delete-confirm="true"]')) {
      return;
    }
    setIsConfirmingDelete(false);
  };

  return (
    <div className="current-sql-header" onClickCapture={cancelDeleteOnOtherClick}>
      <div className="current-sql-title-block">
        {isEditing ? (
          <form
            className="current-sql-title-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveTitle();
            }}
          >
            <input
              aria-label="Opened SQL title"
              autoFocus
              className="lineage-output-title-input current-sql-title-input"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelEdit();
                  return;
                }
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  saveTitle();
                }
              }}
            />
            <button className="lineage-copy-button" type="submit">Save</button>
            <button className="lineage-copy-button" type="button" onClick={cancelEdit}>Cancel</button>
          </form>
        ) : (
          <button
            className="current-sql-title current-sql-title-button"
            title="Double-click to rename"
            type="button"
            onDoubleClick={() => {
              setIsConfirmingDelete(false);
              setIsEditing(true);
            }}
          >
            {outputTitle}
          </button>
        )}
      </div>
      {!isEditing ? (
        <div className="current-sql-actions">
          <button
            className="lineage-copy-button"
            type="button"
            onClick={() => {
              setIsConfirmingDelete(false);
              setIsEditing(true);
            }}
          >
            <Pencil size={12} aria-hidden="true" />
            <span>Edit</span>
          </button>
          <button
            className={`lineage-copy-button lineage-output-title-delete-button ${isConfirmingDelete ? 'lineage-output-title-delete-confirm' : ''}`}
            data-current-sql-delete-confirm="true"
            type="button"
            onClick={requestDelete}
          >
            <Trash2 size={12} aria-hidden="true" />
            <span>{isConfirmingDelete ? 'Confirm' : 'Delete'}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function useMobileLineageViewport() {
  const [isMobileLineageViewport, setIsMobileLineageViewport] = useState(readIsMobileLineageViewport);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const query = window.matchMedia(mobileLineageViewportQuery);
    const updateMobileLineageViewport = () => setIsMobileLineageViewport(query.matches);
    updateMobileLineageViewport();
    query.addEventListener('change', updateMobileLineageViewport);
    return () => query.removeEventListener('change', updateMobileLineageViewport);
  }, []);

  return isMobileLineageViewport;
}

function readIsMobileLineageViewport() {
  return typeof window !== 'undefined' && window.matchMedia(mobileLineageViewportQuery).matches;
}

function summarizeAnalysisWarnings(warnings: AnalysisWarning[], unreachableCteCount: number): WarningCounters {
  const counters: WarningCounters = {
    cteSql: 0,
    undefinedSources: 0,
    duplicates: 0,
    ddl: 0,
    unresolvedColumns: 0,
    other: 0,
    unsupported: 0,
    unusedCtes: unreachableCteCount,
    wildcards: 0,
  };

  for (const warning of warnings) {
    const code = warning.code;
    if (code === 'unused_cte') {
      continue;
    }
    if (code === 'deadlink_unknown_unqualified_column') {
      counters.unresolvedColumns += 1;
    } else if (code === 'deadlink_unknown_qualified_source') {
      counters.undefinedSources += 1;
    } else if (code.startsWith('deadlink_')) {
      counters.unresolvedColumns += 1;
    } else if (code.startsWith('wildcard_')) {
      counters.wildcards += 1;
    } else if (code.startsWith('ddl_')) {
      counters.ddl += 1;
    } else if (code.startsWith('cte-executable-sql-')) {
      counters.cteSql += 1;
    } else if (code.startsWith('unsupported-')) {
      counters.unsupported += 1;
    } else if (code.startsWith('rawsql_duplicate_')) {
      counters.duplicates += 1;
    } else {
      counters.other += 1;
    }
  }

  return counters;
}

function LegendPanel() {
  return (
    <aside className="legend-panel" aria-label="Legend panel">
      <div className="legend-panel-heading">
        <div>
          <h2>Legend</h2>
          <p>How to read graph symbols and row lineage risk badges.</p>
        </div>
      </div>
      <section className="legend-panel-section">
        <h3>Node types</h3>
        <div className="legend-panel-list">
          <span><i className="legend-dot table" />Table</span>
          <span><i className="legend-dot cte" />CTE</span>
          <span><i className="legend-dot derived" />Derived</span>
          <span><i className="legend-dot union" />Union</span>
          <span><i className="legend-dot scalar-subquery" />Scalar Subquery</span>
          <span><i className="legend-dot parameter-table" />Parameter Table</span>
          <span><i className="legend-dot output" />Output</span>
        </div>
      </section>
      <section className="legend-panel-section">
        <h3>Lines</h3>
        <div className="legend-panel-list">
          <span><i className="legend-line data" />Inner join / Data flow</span>
          <span><i className="legend-line outer" />Outer join</span>
          <span><i className="legend-line predicate-subquery" />Predicate subquery</span>
        </div>
      </section>
      <section className="legend-panel-section">
        <h3>Row Lineage badges</h3>
        <p className="legend-panel-note">Badges are Focus annotations for the selected column and symptom: yellow marks signal owners, blue marks referenced inputs, and purple marks source data to review.</p>
        <dl className="legend-impact-list">
          <div><dt><i className="legend-badge">Where</i></dt><dd>WHERE / EXISTS may filter rows</dd></div>
          <div><dt><i className="legend-badge">Having</i></dt><dd>HAVING may filter groups</dd></div>
          <div><dt><i className="legend-badge">Join xN</i></dt><dd>JOIN may drop or multiply rows</dd></div>
          <div><dt><i className="legend-badge">Outer Join</i></dt><dd>OUTER JOIN may add NULLs</dd></div>
          <div><dt><i className="legend-badge">Distinct</i></dt><dd>DISTINCT may remove duplicate output rows</dd></div>
          <div><dt><i className="legend-badge">Distinct On</i></dt><dd>DISTINCT ON selects one row per key</dd></div>
          <div><dt><i className="legend-badge">Group By</i></dt><dd>GROUP BY may change grain/counts</dd></div>
          <div><dt><i className="legend-badge">Limit</i></dt><dd>LIMIT / OFFSET may cap rows</dd></div>
          <div><dt><i className="legend-badge">Top-N</i></dt><dd>ORDER BY with LIMIT / OFFSET selects retained rows</dd></div>
          <div><dt><i className="legend-badge legend-badge-reference">Ref: ...</i></dt><dd>Referenced by the selected row-lineage signal</dd></div>
          <div><dt><i className="legend-badge legend-badge-source-data">Data</i></dt><dd>Source data used by the selected value lineage</dd></div>
        </dl>
      </section>
    </aside>
  );
}

function SqlHistoryPanel({
  history,
  onClear,
  onOpen,
  onRemove,
}: {
  history: SqlHistoryItem[];
  onClear: () => void;
  onOpen: (item: SqlHistoryItem) => void;
  onRemove: (id: string) => void;
}) {
  const [sortMode, setSortMode] = useState<SqlHistorySortMode>(readSqlHistorySortMode);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);
  const visibleHistory = useMemo(() => {
    if (sortMode === 'recent') {
      return history;
    }

    return [...history].sort((a, b) => {
      const titleCompare = getSqlHistoryDisplayTitle(a).localeCompare(getSqlHistoryDisplayTitle(b), undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      return titleCompare || b.openedAt.localeCompare(a.openedAt);
    });
  }, [history, sortMode]);

  useEffect(() => {
    if (history.length === 0) {
      setConfirmingClear(false);
    }
    if (confirmingRemoveId && !history.some((item) => item.id === confirmingRemoveId)) {
      setConfirmingRemoveId(null);
    }
  }, [confirmingRemoveId, history]);

  const handleOpen = (item: SqlHistoryItem) => {
    setConfirmingClear(false);
    setConfirmingRemoveId(null);
    onOpen(item);
  };

  const requestClear = () => {
    setConfirmingRemoveId(null);
    setConfirmingClear(true);
  };

  const confirmClear = () => {
    setConfirmingClear(false);
    onClear();
  };

  const requestRemove = (id: string) => {
    setConfirmingClear(false);
    setConfirmingRemoveId(id);
  };

  const confirmRemove = (id: string) => {
    setConfirmingRemoveId(null);
    onRemove(id);
  };

  const cancelPendingDelete = () => {
    setConfirmingClear(false);
    setConfirmingRemoveId(null);
  };

  const cancelPendingDeleteOnOtherClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!confirmingClear && !confirmingRemoveId) {
      return;
    }
    if ((event.target as HTMLElement).closest('[data-sql-history-confirm-delete="true"]')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    cancelPendingDelete();
  };

  return (
    <div className="sql-history" data-testid="sql-history" onClickCapture={cancelPendingDeleteOnOtherClick}>
      <div className="sql-history-heading">
        <div>
          <div className="lineage-inspector-kicker">History</div>
          <h2>Opened SQL</h2>
        </div>
        <div className="sql-history-heading-actions">
          <label className="sql-history-sort">
            <span>Sort</span>
            <select
              value={sortMode}
              onChange={(event) => {
                const nextSortMode = event.target.value === 'name' ? 'name' : 'recent';
                setSortMode(nextSortMode);
                writeSqlHistorySortMode(nextSortMode);
              }}
            >
              <option value="recent">Recent</option>
              <option value="name">Name</option>
            </select>
          </label>
          {confirmingClear ? (
            <span className="sql-history-confirm">
              <button className="text-button sql-history-confirm-delete" type="button" data-sql-history-confirm-delete="true" onClick={confirmClear}>
                <Trash2 size={13} />
                Clear
              </button>
            </span>
          ) : (
            <button className="text-button" type="button" disabled={history.length === 0} onClick={requestClear}>
              <Trash2 size={13} />
              Clear
            </button>
          )}
        </div>
      </div>
      {history.length > 0 ? (
        <div className="sql-history-list">
          {visibleHistory.map((item) => (
            <article className="sql-history-item" key={item.id}>
              <button className="sql-history-main" type="button" onClick={() => handleOpen(item)}>
                <span className="sql-history-title">{getSqlHistoryDisplayTitle(item)}</span>
                <SqlCodeMirror className="sql-history-code" value={compactSql(item.sql)} />
              </button>
              <div className="sql-history-actions">
                {confirmingRemoveId === item.id ? (
                  <button className="sql-history-action sql-history-remove sql-history-confirm-action" type="button" data-sql-history-confirm-delete="true" aria-label={`Confirm removing ${getSqlHistoryDisplayTitle(item)} from history`} onClick={() => confirmRemove(item.id)}>
                    <Trash2 size={13} />
                    <span>Delete</span>
                  </button>
                ) : (
                  <button className="sql-history-action sql-history-remove" type="button" aria-label={`Remove ${getSqlHistoryDisplayTitle(item)} from history`} onClick={() => requestRemove(item.id)}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="lineage-inspector-empty">Analyzed SQL will appear here.</div>
      )}
    </div>
  );
}

function getSqlHistoryDisplayTitle(item: SqlHistoryItem) {
  return item.outputTitle ?? item.title;
}

function readInitialSqlFromUrl() {
  if (typeof window === 'undefined') {
    return salesSummarySql;
  }

  const hashSql = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('sql');
  const sharedSql = hashSql ?? new URLSearchParams(window.location.search).get('sql');
  return sharedSql?.trim() ? sharedSql : salesSummarySql;
}

function readInitialSqlHistoryEnabledFromUrl() {
  if (typeof window === 'undefined') {
    return true;
  }

  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const searchParams = new URLSearchParams(window.location.search);
  return (hashParams.get('history') ?? searchParams.get('history')) !== '0';
}

async function copyShareUrl(sql: string, setShareStatus: (status: 'idle' | 'copied' | 'too-long' | 'failed') => void) {
  const shareUrl = buildShareUrl(sql);
  if (shareUrl.length > maxShareUrlLength) {
    setShareStatus('too-long');
    return;
  }

  try {
    await copyText(shareUrl);
    setShareStatus('copied');
  } catch {
    setShareStatus('failed');
  }
}

function buildShareUrl(sql: string) {
  if (typeof window === 'undefined') {
    return '';
  }

  const url = new URL(window.location.href);
  url.search = '';
  url.hash = new URLSearchParams({ sql }).toString();
  return url.toString();
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for browsers or embedded views that expose Clipboard API but deny writes.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();

  if (!copied) {
    throw new Error('Copy command failed.');
  }
}

function readSqlHistory(initialSql: string, shouldRecordInitialSql = true): SqlHistoryItem[] {
  const initialHistory = shouldRecordInitialSql && isSqlHistoryAnalyzable(initialSql) ? [createSqlHistoryItem(initialSql)] : [];
  if (typeof window === 'undefined') {
    return initialHistory;
  }

  try {
    const stored = window.localStorage.getItem(sqlHistoryStorageKey);
    const parsed = stored ? (JSON.parse(stored) as SqlHistoryItem[]) : [];
    if (Array.isArray(parsed) && parsed.length > 0) {
      const history = parsed.filter(isSqlHistoryItem).filter((item) => isSqlHistoryAnalyzable(item.sql)).slice(0, maxSqlHistoryItems);
      writeSqlHistory(history);
      return history;
    }
  } catch {
    // Ignore invalid localStorage values.
  }

  writeSqlHistory(initialHistory);
  return initialHistory;
}

function saveSqlHistory(sql: string, current: SqlHistoryItem[]) {
  const normalizedSql = sql.trim();
  if (!normalizedSql || !isSqlHistoryAnalyzable(normalizedSql)) {
    return current;
  }

  const existing = current.find((item) => item.sql.trim() === normalizedSql);
  const next = [
    {
      ...createSqlHistoryItem(normalizedSql),
      title: existing?.title ?? inferSqlTitle(normalizedSql),
      outputTitle: existing?.outputTitle,
    },
    ...current.filter((item) => item.sql.trim() !== normalizedSql),
  ].slice(0, maxSqlHistoryItems);
  writeSqlHistory(next);
  return next;
}

function upsertSqlHistoryTitle(sql: string, title: string, current: SqlHistoryItem[]) {
  const normalizedSql = sql.trim();
  if (!normalizedSql) {
    return current;
  }

  const existing = current.find((item) => item.sql.trim() === normalizedSql);
  if (existing) {
    return current.map((item) => (item.id === existing.id ? { ...item, outputTitle: title } : item));
  }

  return [{ ...createSqlHistoryItem(normalizedSql), outputTitle: title }, ...current].slice(0, maxSqlHistoryItems);
}

function isSqlHistoryAnalyzable(sql: string) {
  const normalizedSql = sql.trim();
  if (!normalizedSql) {
    return false;
  }

  try {
    analyzeSql(normalizedSql);
    return true;
  } catch {
    return false;
  }
}

function writeSqlHistory(history: SqlHistoryItem[]) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(sqlHistoryStorageKey, JSON.stringify(history));
  } catch {
    // Ignore storage quota or privacy mode failures.
  }
}

function readSqlHistorySortMode(): SqlHistorySortMode {
  if (typeof window === 'undefined') {
    return 'recent';
  }

  try {
    return window.localStorage.getItem(sqlHistorySortStorageKey) === 'name' ? 'name' : 'recent';
  } catch {
    // Ignore storage failures and use the default sort mode.
    return 'recent';
  }
}

function writeSqlHistorySortMode(sortMode: SqlHistorySortMode) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(sqlHistorySortStorageKey, sortMode);
  } catch {
    // Ignore storage quota or privacy mode failures.
  }
}

function readLegendPanelOpen() {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    const stored = window.localStorage.getItem(legendPanelStorageKey);
    if (stored === 'true') {
      return true;
    }
    if (stored === 'false') {
      return false;
    }
  } catch {
    // Ignore storage failures and use the default open state.
  }

  return true;
}

function writeLegendPanelOpen(isOpen: boolean) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(legendPanelStorageKey, String(isOpen));
  } catch {
    // Ignore storage quota or privacy mode failures.
  }
}

function createSqlHistoryItem(sql: string): SqlHistoryItem {
  const normalizedSql = sql.trim();
  return {
    id: `${Date.now()}:${hashText(normalizedSql)}`,
    openedAt: new Date().toISOString(),
    sql: normalizedSql,
    title: inferSqlTitle(normalizedSql),
  };
}

function isSqlHistoryItem(value: unknown): value is SqlHistoryItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SqlHistoryItem).id === 'string' &&
    typeof (value as SqlHistoryItem).openedAt === 'string' &&
    typeof (value as SqlHistoryItem).sql === 'string' &&
    typeof (value as SqlHistoryItem).title === 'string'
  );
}

function inferSqlTitle(sql: string) {
  const firstMeaningfulLine =
    sql
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('--')) ?? 'Untitled SQL';
  return firstMeaningfulLine.length > 48 ? `${firstMeaningfulLine.slice(0, 45)}...` : firstMeaningfulLine;
}

function normalizeSqlHistoryTitle(title: string, sql: string) {
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return inferSqlTitle(sql);
  }
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function findSqlHistoryOutputTitle(sql: string, history: SqlHistoryItem[]) {
  const normalizedSql = sql.trim();
  return history.find((item) => item.sql.trim() === normalizedSql)?.outputTitle;
}

function compactSql(sql: string) {
  const compact = sql.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function hashText(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function isSameInspectorSelection(left: InspectorSelection, right: InspectorSelection) {
  if (left?.kind !== right?.kind) {
    return false;
  }
  if (!left || !right) {
    return left === right;
  }
  if (left.kind === 'column' && right.kind === 'column') {
    return left.selected.node.id === right.selected.node.id && left.selected.column.id === right.selected.column.id;
  }
  if (left.kind === 'node' && right.kind === 'node') {
    return left.node.id === right.node.id;
  }
  return false;
}

function isSameInspectorCardSelection(left: InspectorCardSelection | null, right: InspectorCardSelection | null) {
  if (!left || !right) {
    return left === right;
  }
  return left.cardId === right.cardId && left.columnId === right.columnId && left.focusNodeId === right.focusNodeId;
}

function readInspectorCardHistoryState(state: unknown): InspectorCardSelection | null {
  if (!isRecord(state)) {
    return null;
  }

  const value = state[inspectorCardHistoryStateKey];
  if (!isRecord(value) || typeof value.cardId !== 'string') {
    return null;
  }

  return {
    cardId: value.cardId,
    columnId: typeof value.columnId === 'string' ? value.columnId : undefined,
    focusNodeId: typeof value.focusNodeId === 'string' ? value.focusNodeId : undefined,
  };
}

function readMobileInspectorHistoryState(state: unknown) {
  return isRecord(state) && state[mobileInspectorHistoryStateKey] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function GitHubMark() {
  return (
    <svg aria-hidden="true" className="github-mark" focusable="false" viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.67 0 8.2c0 3.63 2.29 6.7 5.47 7.79.4.08.55-.18.55-.4 0-.2-.01-.86-.01-1.56-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.97-.82-1.17-.28-.15-.68-.52-.01-.53.63-.01 1.08.59 1.23.84.72 1.24 1.87.89 2.33.68.07-.53.28-.89.51-1.1-1.78-.21-3.64-.91-3.64-4.04 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.42 7.42 0 0 1 8 3.96c.68 0 1.36.09 2 .28 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.14-1.87 3.83-3.65 4.04.29.26.54.76.54 1.53 0 1.1-.01 1.99-.01 2.26 0 .22.15.48.55.4A8.1 8.1 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z"
      />
    </svg>
  );
}
