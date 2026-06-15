import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check, Copy, ExternalLink, Eye, EyeOff, X } from 'lucide-react';
import type { GraphNode } from '../domain/graph';

export function LineageNodeCard({ data }: NodeProps<GraphNode>) {
  const node = data.lineageNode;
  const columnsVisible = data.columnsVisible ?? true;
  const nodeRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={nodeRef}
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
        <CommentBubble
          anchorRef={nodeRef}
          comments={node.comments}
          cteExecutableSql={node.cteExecutableSql}
          onClose={() => data.onCommentClose?.(nodeCommentTargetId(node.id))}
          variant="node"
        />
      ) : null}
      {columnsVisible ? (
        <div className="lineage-node-body">
          {node.columns.length > 0 ? (
            node.columns.map((column) => (
              <LineageColumnRow column={column} data={data} key={column.id} nodeId={node.id} />
            ))
          ) : (
            <div className="lineage-column lineage-column-muted">columns unresolved</div>
          )}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function LineageColumnRow({
  column,
  data,
  nodeId,
}: {
  column: GraphNode['data']['lineageNode']['columns'][number];
  data: GraphNode['data'];
  nodeId: string;
}) {
  const columnRef = useRef<HTMLButtonElement>(null);
  const isSelected = data.selectedColumnId === column.id;
  const isCommentSelected = data.selectedCommentTargetIds?.has(columnCommentTargetId(column.id)) ?? false;
  const isSource = data.sourceColumnIds?.has(column.id) ?? false;
  const isHighlighted = data.highlightedColumnIds?.has(column.id) ?? false;

  return (
    <div className="lineage-column-group">
      <button
        ref={columnRef}
        className={`lineage-column ${isSelected ? 'lineage-column-selected' : ''} ${isSource ? 'lineage-column-source' : ''} ${isHighlighted ? 'lineage-column-highlighted' : ''} ${isCommentSelected ? 'lineage-comment-selected' : ''} nodrag`}
        onClick={(event) => {
          event.stopPropagation();
          data.onColumnSelect?.(nodeId, column);
        }}
        type="button"
      >
        {column.name}
      </button>
      {isCommentSelected && (column.comments?.length || column.expressionSql) ? (
        <CommentBubble
          anchorRef={columnRef}
          comments={column.comments}
          expressionSql={column.expressionSql}
          onClose={() => data.onCommentClose?.(columnCommentTargetId(column.id))}
          variant="column"
        />
      ) : null}
    </div>
  );
}

function CommentBubble({
  anchorRef,
  comments,
  expressionSql,
  cteExecutableSql,
  onClose,
  variant,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  comments?: string[];
  expressionSql?: string;
  cteExecutableSql?: string;
  onClose?: () => void;
  variant: 'column' | 'node';
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    let animationFrame = 0;

    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) {
        animationFrame = window.requestAnimationFrame(updatePosition);
        return;
      }

      const anchorRect = anchor.getBoundingClientRect();
      const bubbleRect = bubbleRef.current?.getBoundingClientRect();
      const bubbleWidth = bubbleRect?.width ?? 320;
      const bubbleHeight = bubbleRect?.height ?? 120;
      const nextLeft = Math.min(anchorRect.right + 10, window.innerWidth - bubbleWidth - 12);
      const preferredTop = variant === 'node' ? anchorRect.top : anchorRect.top - 4;
      const nextTop = Math.max(8, Math.min(preferredTop, window.innerHeight - bubbleHeight - 8));

      setPosition((current) =>
        current && Math.abs(current.left - nextLeft) < 0.5 && Math.abs(current.top - nextTop) < 0.5
          ? current
          : { left: nextLeft, top: nextTop },
      );
      animationFrame = window.requestAnimationFrame(updatePosition);
    };

    updatePosition();
    return () => window.cancelAnimationFrame(animationFrame);
  }, [anchorRef, variant]);

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

  return createPortal(
    <div
      ref={bubbleRef}
      className={`lineage-comment-bubble lineage-comment-bubble-${variant} ${cteExecutableSql ? 'lineage-comment-bubble-has-sql' : ''} nodrag`}
      data-testid="lineage-comment"
      style={position ? { left: position.left, top: position.top } : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        aria-label="Close comment"
        className="lineage-comment-close nodrag"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClose?.();
        }}
      >
        <X size={12} aria-hidden="true" />
      </button>
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
            <div className="lineage-comment-actions">
              <a
                className="lineage-open-link nodrag"
                href={buildViewerSqlUrl(cteExecutableSql)}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                <ExternalLink size={12} aria-hidden="true" />
                Open in viewer
              </a>
              <button className="lineage-copy-button nodrag" type="button" onClick={copyCteSql}>
                {copyState === 'copied' ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy SQL'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function buildViewerSqlUrl(sql: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('sql', sql);
  return url.toString();
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
