import { useState, type MouseEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check, Copy, Database, Eye, EyeOff, FileJson2, GitBranch, Table2 } from 'lucide-react';
import type { GraphNode } from '../domain/graph';

const iconByType = {
  table: Table2,
  cte: GitBranch,
  derived: FileJson2,
  output: Database,
};

export function LineageNodeCard({ data }: NodeProps<GraphNode>) {
  const node = data.lineageNode;
  const Icon = iconByType[node.type];
  const columnsVisible = data.columnsVisible ?? true;

  return (
    <div
      className={`lineage-node lineage-node-${node.type} ${columnsVisible ? 'lineage-node-expanded' : 'lineage-node-collapsed'}`}
      data-testid={`lineage-node-${node.type}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="lineage-node-header">
        <button
          className={`lineage-node-title lineage-node-title-button ${data.selectedCommentTargetIds?.has(nodeCommentTargetId(node.id)) ? 'lineage-comment-selected' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            data.onNodeSelect?.(node.id);
          }}
          type="button"
        >
          <Icon size={15} aria-hidden="true" />
          {node.label}
        </button>
        <div className="lineage-node-actions">
          <button
            aria-label={`${columnsVisible ? 'Hide' : 'Show'} columns for ${node.label}`}
            className="node-icon-button nodrag"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              data.onToggleColumns?.(node.id);
            }}
          >
            {columnsVisible ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <span className="lineage-node-kind">{node.type}</span>
        </div>
      </div>
      {data.selectedCommentTargetIds?.has(nodeCommentTargetId(node.id)) && (node.comments?.length || node.cteExecutableSql) ? (
        <CommentBubble comments={node.comments} cteExecutableSql={node.cteExecutableSql} variant="node" />
      ) : null}
      {columnsVisible ? (
        <div className="lineage-node-body">
          {node.columns.length > 0 ? (
            node.columns.map((column) => {
              const isSelected = data.selectedColumnId === column.id;
              const isCommentSelected = data.selectedCommentTargetIds?.has(columnCommentTargetId(column.id)) ?? false;
              const isSource = data.sourceColumnIds?.has(column.id) ?? false;
              const isHighlighted = data.highlightedColumnIds?.has(column.id) ?? false;
              return (
                <div className="lineage-column-group" key={column.id}>
                  <button
                    className={`lineage-column ${isSelected ? 'lineage-column-selected' : ''} ${isSource ? 'lineage-column-source' : ''} ${isHighlighted ? 'lineage-column-highlighted' : ''} ${isCommentSelected ? 'lineage-comment-selected' : ''} nodrag`}
                    onClick={(event) => {
                      event.stopPropagation();
                      data.onColumnSelect?.(node.id, column);
                    }}
                    type="button"
                  >
                    {column.name}
                  </button>
                  {isCommentSelected && (column.comments?.length || column.expressionSql) ? (
                    <CommentBubble comments={column.comments} expressionSql={column.expressionSql} variant="column" />
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="lineage-column lineage-column-muted">columns unresolved</div>
          )}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function CommentBubble({
  comments,
  expressionSql,
  cteExecutableSql,
  variant,
}: {
  comments?: string[];
  expressionSql?: string;
  cteExecutableSql?: string;
  variant: 'column' | 'node';
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyCteSql = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!cteExecutableSql) {
      return;
    }

    try {
      await copyText(cteExecutableSql);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      setCopyState('failed');
      window.setTimeout(() => setCopyState('idle'), 2200);
    }
  };

  return (
    <div
      className={`lineage-comment-bubble lineage-comment-bubble-${variant} ${cteExecutableSql ? 'lineage-comment-bubble-has-sql' : ''} nodrag`}
      data-testid="lineage-comment"
    >
      {comments && comments.length > 0 ? (
        <div className="lineage-comment-section">
          <div className="lineage-comment-label">Comment</div>
          {comments.map((comment) => (
            <div key={comment}>{comment}</div>
          ))}
        </div>
      ) : null}
      {expressionSql ? (
        <div className="lineage-comment-section">
          <div className="lineage-comment-label">Expression</div>
          <code className="lineage-expression">{expressionSql}</code>
        </div>
      ) : null}
      {cteExecutableSql ? (
        <div className="lineage-comment-section">
          <div className="lineage-comment-heading">
            <div className="lineage-comment-label">CTE SQL</div>
            <button className="lineage-copy-button nodrag" type="button" onClick={copyCteSql}>
              {copyState === 'copied' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy SQL'}
            </button>
          </div>
          <pre className="lineage-sql-preview">
            <code>{cteExecutableSql}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for embedded browsers or permission-limited contexts.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error('Clipboard copy failed.');
  }
}

function nodeCommentTargetId(nodeId: string) {
  return `node:${nodeId}`;
}

function columnCommentTargetId(columnId: string) {
  return `column:${columnId}`;
}
