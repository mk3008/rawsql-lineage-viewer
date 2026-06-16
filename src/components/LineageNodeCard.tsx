import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Eye, EyeOff, Maximize2, Minimize2, X } from 'lucide-react';
import type { GraphNode } from '../domain/graph';
import type { LineageColumnUsageReason } from '../domain/lineage';
import { hasColumnCalloutContent, isPassthroughColumn, isSimpleColumnReference } from '../lineage/columnDisplay';

export function LineageNodeCard({ data }: NodeProps<GraphNode>) {
  const node = data.lineageNode;
  const columnsVisible = data.columnsVisible ?? true;
  const nodeRef = useRef<HTMLDivElement>(null);
  const canTogglePassthrough = node.type !== 'output' && node.columns.some(isPassthroughColumn);
  const passthroughCompressed = data.passthroughColumnsCompressed ?? false;
  const isPassthroughOnly =
    columnsVisible && !data.collapsedGroup && node.columns.length > 0 && node.columns.every((column) => isCompressedPassthroughColumn(column, data));

  return (
    <div
      ref={nodeRef}
      className={`lineage-node lineage-node-${node.type} ${data.collapsedGroup ? 'lineage-node-collapsed-group' : ''} ${columnsVisible ? 'lineage-node-expanded' : 'lineage-node-collapsed'} ${isPassthroughOnly ? 'lineage-node-passthrough-only' : ''}`}
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
          {canTogglePassthrough ? (
            <button
              aria-label={`${passthroughCompressed ? 'Show' : 'Compress'} passthrough columns for ${node.label}`}
              className="node-icon-button nodrag"
              title={`${passthroughCompressed ? 'Show' : 'Compress'} passthrough columns`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                data.onTogglePassthroughColumns?.(node.id);
              }}
            >
              {passthroughCompressed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          ) : null}
          {data.collapsedGroup ? (
            <button
              aria-label={`Expand ${data.collapsedGroup.label}`}
              className="node-icon-button nodrag"
              title="Expand group"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                data.onExpandGroup?.(node.id);
              }}
            >
              <Maximize2 size={13} />
            </button>
          ) : data.canCollapseUpstream ? (
            <button
              aria-label={`Collapse inner query for ${node.label}`}
              className="node-icon-button nodrag"
              title="Collapse inner query"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                data.onCollapseUpstream?.(node.id);
              }}
            >
              <Minimize2 size={13} />
            </button>
          ) : null}
          <span className="lineage-node-kind">{data.collapsedGroup ? 'Group' : node.type}</span>
        </div>
      </div>
      {data.selectedCommentTargetIds?.has(nodeCommentTargetId(node.id)) && (node.comments?.length || node.cteExecutableSql) ? (
        <CommentBubble
          anchorRef={nodeRef}
          comments={node.comments}
          cteExecutableSql={node.cteExecutableSql}
          isActive={data.activeCommentTargetId === nodeCommentTargetId(node.id)}
          onClose={() => data.onCommentClose?.(nodeCommentTargetId(node.id))}
          onFocus={() => data.onCommentFocus?.(nodeCommentTargetId(node.id))}
          viewportZoom={data.viewportZoom ?? 1}
          variant="node"
        />
      ) : null}
      {columnsVisible ? (
        <div className="lineage-node-body">
          {data.collapsedGroup ? (
            <CollapsedGroupBody data={data} nodeId={node.id} />
          ) : node.columns.length > 0 ? (
            <LineageColumnList columns={node.columns} data={data} nodeId={node.id} />
          ) : (
            <div className="lineage-column lineage-column-muted">columns unresolved</div>
          )}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function CollapsedGroupBody({ data, nodeId }: { data: GraphNode['data']; nodeId: string }) {
  const group = data.collapsedGroup;
  if (!group) {
    return null;
  }

  return (
    <div className="lineage-group-summary">
      <div className="lineage-group-section">
        <div className="lineage-group-summary-title">Output</div>
        {data.lineageNode.columns.length > 0 ? (
          <LineageColumnList columns={data.lineageNode.columns} data={data} nodeId={nodeId} />
        ) : (
          <div className="lineage-column lineage-column-muted">columns unresolved</div>
        )}
      </div>
      <div className="lineage-group-section">
        <div className="lineage-group-summary-title">Input</div>
        <ul className="lineage-group-hidden-list">
          {group.helperNodes.map((node) => (
            <li key={node.id}>
              <span className="lineage-group-hidden-type">{node.type === 'cte' ? 'CTE' : 'Subquery'}</span>
              <span className="lineage-group-hidden-name">{node.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function LineageColumnList({
  columns,
  data,
  nodeId,
}: {
  columns: GraphNode['data']['lineageNode']['columns'];
  data: GraphNode['data'];
  nodeId: string;
}) {
  const shouldCompress = data.passthroughColumnsCompressed ?? false;
  const valueColumns = columns.filter((column) => !column.usage);
  const conditionColumns = columns.filter((column) => column.usage?.role === 'condition');
  const unusedColumns = columns.filter((column) => column.usage?.role === 'unused');
  const visibleValueColumns = shouldCompress ? valueColumns.filter((column) => !isCompressedPassthroughColumn(column, data)) : valueColumns;
  const compressedCount = shouldCompress ? valueColumns.length - visibleValueColumns.length : 0;

  return (
    <>
      {visibleValueColumns.map((column) => (
        <LineageColumnRow column={column} data={data} key={column.id} nodeId={nodeId} />
      ))}
      {compressedCount > 0 ? <PassthroughSummary count={compressedCount} /> : null}
      {conditionColumns.length > 0 ? (
        <LineageColumnSection columns={conditionColumns} data={data} label="Condition" nodeId={nodeId} />
      ) : null}
      {unusedColumns.length > 0 ? <LineageColumnSection columns={unusedColumns} data={data} label="Unused" nodeId={nodeId} /> : null}
    </>
  );
}

function LineageColumnSection({
  columns,
  data,
  label,
  nodeId,
}: {
  columns: GraphNode['data']['lineageNode']['columns'];
  data: GraphNode['data'];
  label: string;
  nodeId: string;
}) {
  return (
    <div className="lineage-column-section">
      <div className="lineage-column-section-title">{label}</div>
      {columns.map((column) => (
        <LineageColumnRow column={column} data={data} key={column.id} nodeId={nodeId} />
      ))}
    </div>
  );
}

function isCompressedPassthroughColumn(column: GraphNode['data']['lineageNode']['columns'][number], data: GraphNode['data']) {
  return (
    isPassthroughColumn(column) &&
    data.selectedColumnId !== column.id &&
    !(data.highlightedColumnIds?.has(column.id) ?? false) &&
    !(data.sourceColumnIds?.has(column.id) ?? false) &&
    !(data.selectedCommentTargetIds?.has(columnCommentTargetId(column.id)) ?? false)
  );
}

function PassthroughSummary({ count }: { count: number }) {
  return (
    <div className="lineage-passthrough-summary" title={`${count} passthrough columns hidden`}>
      Passthrough <strong>{count}</strong>
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
  const usageClass =
    column.usage?.role === 'condition' ? 'lineage-column-condition' : column.usage?.role === 'unused' ? 'lineage-column-unused' : '';

  return (
    <div className="lineage-column-group">
      <button
        ref={columnRef}
        className={`lineage-column ${usageClass} ${isSelected ? 'lineage-column-selected' : ''} ${isSource ? 'lineage-column-source' : ''} ${isHighlighted ? 'lineage-column-highlighted' : ''} ${isCommentSelected ? 'lineage-comment-selected' : ''} nodrag`}
        onClick={(event) => {
          event.stopPropagation();
          data.onColumnSelect?.(nodeId, column);
        }}
        type="button"
      >
        {column.name}
      </button>
      {isCommentSelected && hasColumnCalloutContent(column) ? (
        <CommentBubble
          anchorRef={columnRef}
          comments={column.comments}
          expressionSql={column.expressionSql && !isSimpleColumnReference(column.expressionSql) ? column.expressionSql : undefined}
          usageText={formatUsageText(column)}
          isActive={data.activeCommentTargetId === columnCommentTargetId(column.id)}
          onClose={() => data.onCommentClose?.(columnCommentTargetId(column.id))}
          onFocus={() => data.onCommentFocus?.(columnCommentTargetId(column.id))}
          viewportZoom={data.viewportZoom ?? 1}
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
  usageText,
  isActive,
  onClose,
  onFocus,
  viewportZoom,
  variant,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  comments?: string[];
  expressionSql?: string;
  cteExecutableSql?: string;
  usageText?: string;
  isActive?: boolean;
  onClose?: () => void;
  onFocus?: () => void;
  viewportZoom: number;
  variant: 'column' | 'node';
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; visible: boolean } | null>(null);

  useLayoutEffect(() => {
    let animationFrame = 0;

    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) {
        animationFrame = window.requestAnimationFrame(updatePosition);
        return;
      }

      const anchorRect = anchor.getBoundingClientRect();
      const visibleRect = getVisibleGraphRect(anchor);
      if (!visibleRect || !rectContains(visibleRect, anchorRect)) {
        setPosition((current) => (current?.visible === false ? current : { left: current?.left ?? 0, top: current?.top ?? 0, visible: false }));
        animationFrame = window.requestAnimationFrame(updatePosition);
        return;
      }

      const bubbleRect = bubbleRef.current?.getBoundingClientRect();
      const bubbleWidth = bubbleRect?.width ?? 320;
      const bubbleHeight = bubbleRect?.height ?? 120;
      const nextLeft = anchorRect.right + 10;
      const preferredTop = variant === 'node' ? anchorRect.top : anchorRect.top - 4;
      const nextTop = preferredTop;
      const nextBubbleRect = {
        bottom: nextTop + bubbleHeight,
        left: nextLeft,
        right: nextLeft + bubbleWidth,
        top: nextTop,
      };
      const nextVisible = rectContains(visibleRect, nextBubbleRect);

      setPosition((current) =>
        current?.visible === nextVisible && Math.abs(current.left - nextLeft) < 0.5 && Math.abs(current.top - nextTop) < 0.5
          ? current
          : { left: nextLeft, top: nextTop, visible: nextVisible },
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

  const bubbleStyle: CSSProperties & { '--lineage-comment-scale': string } = {
    left: position?.left ?? 0,
    top: position?.top ?? 0,
    visibility: position?.visible ? 'visible' : 'hidden',
    pointerEvents: position?.visible ? 'auto' : 'none',
    '--lineage-comment-scale': String(viewportZoom),
    zIndex: isActive ? 100001 : 100000,
  };

  return createPortal(
    <div
      ref={bubbleRef}
      className={`lineage-comment-bubble lineage-comment-bubble-${variant} ${cteExecutableSql ? 'lineage-comment-bubble-has-sql' : ''} nodrag`}
      data-testid="lineage-comment"
      style={bubbleStyle}
      onMouseDown={(event) => {
        event.stopPropagation();
        onFocus?.();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onFocus?.();
      }}
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
          {comments.map((comment) => (
            <div key={comment}>{comment}</div>
          ))}
        </div>
      ) : null}
      {usageText ? <div className="lineage-comment-section">{usageText}</div> : null}
      {expressionSql ? (
        <div className="lineage-comment-section">
          <code className="lineage-expression">{expressionSql}</code>
        </div>
      ) : null}
      {cteExecutableSql ? (
        <div className="lineage-comment-section">
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
      ) : null}
    </div>,
    document.body,
  );
}

function formatUsageText(column: GraphNode['data']['lineageNode']['columns'][number]): string | undefined {
  if (column.usage?.role !== 'condition') {
    return undefined;
  }
  const reasons = column.usage.reasons?.map(formatUsageReason) ?? ['Condition'];
  return `Used by: ${[...new Set(reasons)].join(', ')}`;
}

function formatUsageReason(reason: LineageColumnUsageReason): string {
  if (reason === 'groupBy') return 'GROUP BY';
  if (reason === 'orderBy') return 'ORDER BY';
  return reason.toUpperCase();
}

type RectLike = Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>;

function getVisibleGraphRect(anchor: HTMLElement) {
  const graphShellRect = anchor.closest('.graph-shell')?.getBoundingClientRect();
  const viewportRect = {
    bottom: window.innerHeight,
    left: 0,
    right: window.innerWidth,
    top: 0,
  };
  return graphShellRect ? intersectRects(graphShellRect, viewportRect) : viewportRect;
}

function intersectRects(a: RectLike, b: RectLike): RectLike | null {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { bottom, left, right, top } : null;
}

function rectContains(container: RectLike, rect: RectLike) {
  return rect.left >= container.left && rect.right <= container.right && rect.top >= container.top && rect.bottom <= container.bottom;
}

function buildViewerSqlUrl(sql: string) {
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
