import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Code2, Eraser, Info, PanelLeftClose, PanelLeftOpen, Play, Share2, Trash2 } from 'lucide-react';
import { LineageGraph, LineageInspector, type CaseRuleSelection, type GraphHighlightTarget, type InspectorSelection } from './components/LineageGraph';
import { SqlCodeMirror } from './components/SqlCodeMirror';
import { salesSummarySql } from './examples/salesSummarySql';
import type { GraphFlowDirection } from './graph/buildGraphModel';
import { analyzeSql } from './lineage/rawsqlAdapter';

const maxShareUrlLength = 8000;
const sqlHistoryStorageKey = 'rawsql-lineage-viewer:sql-history';
const maxSqlHistoryItems = 20;
const defaultOutputTitle = 'Final Result';

interface SqlHistoryItem {
  id: string;
  openedAt: string;
  outputTitle?: string;
  sql: string;
  title: string;
}

export function App() {
  const initialSql = useMemo(readInitialSqlFromUrl, []);
  const initialHistory = useMemo(() => readSqlHistory(initialSql), [initialSql]);
  const [sql, setSql] = useState(initialSql);
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<'sql' | 'inspector' | 'history'>('sql');
  const [inspectorSelection, setInspectorSelection] = useState<InspectorSelection>(null);
  const [forcedInspectorSelection, setForcedInspectorSelection] = useState<InspectorSelection>(null);
  const [caseRuleSelection, setCaseRuleSelection] = useState<CaseRuleSelection | null>(null);
  const [autoInspectOutputNonce, setAutoInspectOutputNonce] = useState(0);
  const [expandedExpressionColumnIds, setExpandedExpressionColumnIds] = useState<Set<string>>(() => new Set());
  const [graphFocusTarget, setGraphFocusTarget] = useState<{ nonce: number; nodeId: string } | null>(null);
  const [graphHighlightTarget, setGraphHighlightTarget] = useState<{ nonce: number; target: GraphHighlightTarget } | null>(null);
  const [lastAnalyzedSql, setLastAnalyzedSql] = useState(initialSql);
  const [sqlHistory, setSqlHistory] = useState<SqlHistoryItem[]>(initialHistory);
  const [outputTitle, setOutputTitle] = useState(() => findSqlHistoryOutputTitle(initialSql, initialHistory) ?? defaultOutputTitle);
  const [shareStatus, setShareStatus] = useState<'idle' | 'copied' | 'too-long' | 'failed'>('idle');
  const [flowDirection, setFlowDirection] = useState<GraphFlowDirection>('upstream');
  const lastHandledAutoInspectOutputNonceRef = useRef(0);
  const pendingAutoInspectOutputNonceRef = useRef<number | null>(null);
  const suppressNullInspectorSelectionRef = useRef(false);

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
    setIsPanelOpen(true);
    setPanelTab('inspector');
  }, [adapterResult, autoInspectOutputNonce, outputTitle]);
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
        outputs: adapterResult.lineage.nodes.filter((node) => node.type === 'output').length,
        dataFlows: adapterResult.lineage.edges.filter((edge) => edge.type === 'dataFlow').length,
      }
    : null;
  const handleInspectorSelectionChange = useCallback((selection: InspectorSelection) => {
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
      }
      return selection;
    });
    if (selection) {
      setIsPanelOpen(true);
      setPanelTab('inspector');
    }
  }, []);
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
    setCaseRuleSelection(null);
    setExpandedExpressionColumnIds(new Set());
    setGraphHighlightTarget(null);
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
    if (nextInspectorSelection) {
      setIsPanelOpen(true);
      setPanelTab('inspector');
    }
  }, [sqlHistory]);
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
            Share
          </button>
          <a className="github-link" href="https://github.com/mk3008/rawsql-lineage-viewer" target="_blank" rel="noreferrer">
            <GitHubMark />
            GitHub
          </a>
        </div>
      </header>

      <main className={`workspace ${isPanelOpen ? '' : 'workspace-panel-collapsed'}`}>
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
              <button
                aria-selected={panelTab === 'history'}
                className={panelTab === 'history' ? 'active' : ''}
                role="tab"
                type="button"
                onClick={() => setPanelTab('history')}
              >
                <Clock3 size={15} />
                History
              </button>
            </div>
            {panelTab === 'sql' ? (
              <div className="panel-heading-actions">
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
            ) : null}
          </div>
          {panelTab === 'sql' ? (
            <div className="sql-tab-panel">
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
          ) : panelTab === 'inspector' ? (
            <LineageInspector
              activeCaseRule={caseRuleSelection}
              expandedExpressionColumnIds={expandedExpressionColumnIds}
              flowDirection={flowDirection}
              onClearCaseRule={() => setCaseRuleSelection(null)}
              onRenameOutputTitle={renameOutputTitle}
              onToggleExpressionBreakdown={toggleExpressionBreakdown}
              onFocusNode={(nodeId) => {
                setGraphFocusTarget({ nodeId, nonce: Date.now() });
              }}
              onHighlightTarget={(target) => {
                setGraphHighlightTarget({ target, nonce: Date.now() });
              }}
              selection={forcedInspectorSelection ?? inspectorSelection}
            />
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
        </aside>

        <section className="canvas-area">
          <div className="canvas-toolbar">
            <div className="flow-direction-toggle" role="group" aria-label="Flow direction">
              <button
                aria-pressed={flowDirection === 'downstream'}
                className={flowDirection === 'downstream' ? 'active' : ''}
                type="button"
                onClick={() => setFlowDirection('downstream')}
              >
                Downstream
              </button>
              <button
                aria-pressed={flowDirection === 'upstream'}
                className={flowDirection === 'upstream' ? 'active' : ''}
                type="button"
                onClick={() => setFlowDirection('upstream')}
              >
                Upstream
              </button>
            </div>
            <div className="legend">
              <span><i className="legend-dot table" />Table</span>
              <span><i className="legend-dot cte" />CTE</span>
              <span><i className="legend-dot derived" />Derived</span>
              <span><i className="legend-dot output" />Output</span>
              <span><i className="legend-line data" />Data flow</span>
              <span title="Nullable by OUTER JOIN"><i className="legend-line outer" />Nullable flow</span>
            </div>
          </div>

          {adapterResult ? (
            <>
              <LineageGraph
                autoInspectOutputNonce={autoInspectOutputNonce}
                caseRuleSelection={caseRuleSelection}
                expandedExpressionColumnIds={expandedExpressionColumnIds}
                flowDirection={flowDirection}
                focusTarget={graphFocusTarget}
                highlightTargetRequest={graphHighlightTarget}
                lineage={adapterResult.lineage}
                onInspectorSelectionChange={handleInspectorSelectionChange}
                outputTitle={outputTitle}
              />
              <div className="graph-info" data-testid="graph-info">
                <span>Tables <strong>{graphStats?.tables}</strong></span>
                <span>CTEs <strong>{graphStats?.ctes}</strong></span>
                <span>Derived <strong>{graphStats?.derived}</strong></span>
                <span>Output <strong>{graphStats?.outputs}</strong></span>
                <span>DataFlow <strong>{graphStats?.dataFlows}</strong></span>
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
      </main>
    </div>
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
  return (
    <div className="sql-history" data-testid="sql-history">
      <div className="sql-history-heading">
        <div>
          <div className="lineage-inspector-kicker">History</div>
          <h2>Opened SQL</h2>
        </div>
        <button className="text-button" type="button" disabled={history.length === 0} onClick={onClear}>
          <Trash2 size={13} />
          Clear
        </button>
      </div>
      {history.length > 0 ? (
        <div className="sql-history-list">
          {history.map((item) => (
              <article className="sql-history-item" key={item.id}>
                  <button className="sql-history-main" type="button" onClick={() => onOpen(item)}>
                  <span className="sql-history-title">{item.outputTitle ?? item.title}</span>
                  <span className="sql-history-time">{formatHistoryTime(item.openedAt)}</span>
                  <SqlCodeMirror className="sql-history-code" value={compactSql(item.sql)} />
                </button>
                <div className="sql-history-actions">
                  <button className="sql-history-action sql-history-remove" type="button" aria-label={`Remove ${item.title} from history`} onClick={() => onRemove(item.id)}>
                    <Trash2 size={13} />
                  </button>
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

function readInitialSqlFromUrl() {
  if (typeof window === 'undefined') {
    return salesSummarySql;
  }

  const hashSql = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('sql');
  const sharedSql = hashSql ?? new URLSearchParams(window.location.search).get('sql');
  return sharedSql?.trim() ? sharedSql : salesSummarySql;
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

function readSqlHistory(initialSql: string): SqlHistoryItem[] {
  if (typeof window === 'undefined') {
    return [createSqlHistoryItem(initialSql)];
  }

  try {
    const stored = window.localStorage.getItem(sqlHistoryStorageKey);
    const parsed = stored ? (JSON.parse(stored) as SqlHistoryItem[]) : [];
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.filter(isSqlHistoryItem).slice(0, maxSqlHistoryItems);
    }
  } catch {
    // Ignore invalid localStorage values.
  }

  const initialHistory = [createSqlHistoryItem(initialSql)];
  writeSqlHistory(initialHistory);
  return initialHistory;
}

function saveSqlHistory(sql: string, current: SqlHistoryItem[]) {
  const normalizedSql = sql.trim();
  if (!normalizedSql) {
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

function formatHistoryTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  }).format(date);
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
