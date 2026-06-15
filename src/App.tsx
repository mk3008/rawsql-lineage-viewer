import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Code2, GitBranch, Menu, Play, X } from 'lucide-react';
import { LineageGraph } from './components/LineageGraph';
import { salesSummarySql } from './examples/salesSummarySql';
import { analyzeSql } from './lineage/rawsqlAdapter';

export function App() {
  const initialSql = useMemo(readInitialSqlFromUrl, []);
  const [sql, setSql] = useState(initialSql);
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [lastAnalyzedSql, setLastAnalyzedSql] = useState(initialSql);

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

  const graphStats = adapterResult
    ? {
        tables: adapterResult.lineage.nodes.filter((node) => node.type === 'table').length,
        ctes: adapterResult.lineage.nodes.filter((node) => node.type === 'cte').length,
        derived: adapterResult.lineage.nodes.filter((node) => node.type === 'derived').length,
        outputs: adapterResult.lineage.nodes.filter((node) => node.type === 'output').length,
        dataFlows: adapterResult.lineage.edges.filter((edge) => edge.type === 'dataFlow').length,
      }
    : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <button className="icon-button" type="button" onClick={() => setIsPanelOpen((value) => !value)} aria-label="Toggle SQL panel">
            {isPanelOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
          <div>
            <h1>SQL Lineage Viewer</h1>
            <p>Paste SQL. See the lineage.</p>
          </div>
        </div>
        <a className="github-link" href="https://github.com/" target="_blank" rel="noreferrer">
          <GitBranch size={17} />
          GitHub
        </a>
      </header>

      <main className={`workspace ${isPanelOpen ? '' : 'workspace-panel-collapsed'}`}>
        <aside className="sql-panel" aria-label="SQL editor panel">
          <div className="panel-heading">
            <span>
              <Code2 size={16} />
              SQL
            </span>
            <button className="text-button" type="button" onClick={() => setSql(salesSummarySql)}>
              Load example
            </button>
          </div>
          <textarea
            aria-label="SQL editor"
            className="sql-editor"
            value={sql}
            spellCheck={false}
            onChange={(event) => setSql(event.target.value)}
          />
          <div className="panel-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                setLastAnalyzedSql(sql);
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
        </aside>

        <section className="canvas-area">
          <div className="canvas-toolbar">
            <div className="legend">
              <span><i className="legend-dot table" />Table</span>
              <span><i className="legend-dot cte" />CTE</span>
              <span><i className="legend-dot derived" />Derived</span>
              <span><i className="legend-dot output" />Output</span>
              <span><i className="legend-line data" />Data flow</span>
              <span><i className="legend-line outer" />Outer join</span>
            </div>
          </div>

          {adapterResult ? (
            <>
              <LineageGraph lineage={adapterResult.lineage} />
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

function readInitialSqlFromUrl() {
  if (typeof window === 'undefined') {
    return salesSummarySql;
  }

  const sharedSql = new URLSearchParams(window.location.search).get('sql');
  return sharedSql?.trim() ? sharedSql : salesSummarySql;
}
