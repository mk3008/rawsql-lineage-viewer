import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Check, Copy, ExternalLink, Maximize2, Minimize2, X } from 'lucide-react';
import type { GraphNode } from '../domain/graph';
import type { LineageColumnUsageReason } from '../domain/lineage';
import { hasColumnCalloutContent, isPassthroughColumn, isSimpleColumnReference, isVisibleGraphColumn } from '../lineage/columnDisplay';
import { isUnionNode } from '../lineage/nodeKind';
import { SqlCodeMirror } from './SqlCodeMirror';

export function LineageNodeCard({ id, data }: NodeProps<GraphNode>) {
  const node = data.lineageNode;
  const graphNodeId = id;
  const columnsVisible = data.columnsVisible ?? true;
  const selectedNodeExpanded = data.selectedNodeId === node.id;
  const selectedColumnExpanded = node.columns.some((column) => column.id === data.originSelectedColumnId);
  const columnsExpanded = selectedNodeExpanded || selectedColumnExpanded;
  const forcedVisibleColumnIds = data.forcedVisibleColumnIds ?? new Set<string>();
  const hasForcedVisibleColumns = node.columns.some((column) => forcedVisibleColumnIds.has(column.id));
  const shouldRenderColumns = columnsVisible || columnsExpanded || hasForcedVisibleColumns;
  const nodeRef = useRef<HTMLDivElement>(null);
  const lastTitleTapRef = useRef<{ at: number; nodeId: string } | null>(null);
  const lastTitleInspectAtRef = useRef(0);
  const isPassthroughOnly =
    shouldRenderColumns && !data.collapsedGroup && node.columns.length > 0 && node.columns.every((column) => isCompressedPassthroughColumn(column, data));
  const populationImpactLabels = data.highlightedNodeImpactLabels?.get(node.id) ?? [];
  const referenceLabels = data.highlightedReferenceLabels?.get(node.id) ?? [];
  const sourceDataLabels = data.highlightedSourceDataLabels?.get(node.id) ?? [];
  const isUnion = isUnionNode(node);

  return (
    <div
      ref={nodeRef}
      className={`lineage-node lineage-node-${node.type} ${isUnion ? 'lineage-node-union' : ''} ${data.highlightedNodeIds?.has(node.id) ? `lineage-node-highlighted lineage-node-highlighted-${data.highlightedNodeTone ?? 'value'}` : ''} ${data.dimmed ? 'lineage-node-dimmed' : ''} ${data.collapsedGroup ? 'lineage-node-collapsed-group' : ''} ${columnsVisible || columnsExpanded ? 'lineage-node-expanded' : 'lineage-node-collapsed'} ${isPassthroughOnly ? 'lineage-node-passthrough-only' : ''}`}
      data-testid={`lineage-node-${node.type}`}
    >
      {sourceDataLabels.length > 0 || referenceLabels.length > 0 || data.collapsedGroup || populationImpactLabels.length > 0 ? (
        <div className="lineage-node-badge-stack">
          {sourceDataLabels.length > 0 ? <SourceDataBadges labels={sourceDataLabels} /> : null}
          {referenceLabels.length > 0 ? <ReferenceBadges labels={referenceLabels} /> : null}
          {data.collapsedGroup ? (
            <GroupPopulationImpactBadges group={data.collapsedGroup} highlightedLabels={data.highlightedNodeImpactLabels} />
          ) : populationImpactLabels.length > 0 ? (
            <PopulationImpactBadges labels={populationImpactLabels} />
          ) : null}
        </div>
      ) : null}
      <Handle className="lineage-node-handle lineage-node-handle-target" type="target" position={Position.Left} />
      <div className="lineage-node-header">
        <button
          className={`lineage-node-title lineage-node-title-button ${data.selectedNodeId === node.id ? 'lineage-comment-selected' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            const now = Date.now();
            const lastTap = lastTitleTapRef.current;
            if (data.onNodeInspect && lastTap?.nodeId === node.id && now - lastTap.at <= 320) {
              lastTitleTapRef.current = null;
              lastTitleInspectAtRef.current = now;
              data.onNodeInspect(node.id);
              return;
            }
            lastTitleTapRef.current = { at: now, nodeId: node.id };
            data.onNodeSelect?.(node.id);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (!data.onNodeInspect) {
              return;
            }
            const now = Date.now();
            if (now - lastTitleInspectAtRef.current <= 320) {
              return;
            }
            lastTitleInspectAtRef.current = now;
            lastTitleTapRef.current = null;
            data.onNodeInspect(node.id);
          }}
          type="button"
        >
          {node.label}
        </button>
        <div className="lineage-node-actions">
          <div className="lineage-node-action-buttons">
            {data.showGroupControls && data.collapsedGroup ? (
              <button
                aria-label={`Expand ${data.collapsedGroup.label}`}
                className="node-icon-button nodrag"
                title="Expand group"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  data.onExpandGroup?.(graphNodeId);
                }}
              >
                <Maximize2 size={13} />
              </button>
            ) : data.showGroupControls && data.canCollapseUpstream ? (
              <button
                aria-label={`Collapse inner query for ${node.label}`}
                className="node-icon-button nodrag"
                title="Collapse inner query"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  data.onCollapseUpstream?.(graphNodeId);
                }}
              >
                <Minimize2 size={13} />
              </button>
            ) : null}
          </div>
          <span className={`lineage-node-kind ${node.recursive && !data.collapsedGroup ? 'lineage-node-kind-recursive' : ''}`}>
            {data.collapsedGroup ? 'Group' : node.recursive ? 'Recursive' : isUnion ? 'Union' : formatNodeKind(node.type)}
          </span>
        </div>
      </div>
      {data.selectedCommentTargetIds?.has(nodeCommentTargetId(node.id)) && (node.comments?.length || getNodeSql(node)) ? (
        <CommentBubble
          anchorRef={nodeRef}
          comments={node.comments}
          cteExecutableSql={getNodeSql(node)}
          isActive={data.activeCommentTargetId === nodeCommentTargetId(node.id)}
          onClose={() => data.onCommentClose?.(nodeCommentTargetId(node.id))}
          onFocus={() => data.onCommentFocus?.(nodeCommentTargetId(node.id))}
          viewportZoom={data.viewportZoom ?? 1}
          variant="node"
        />
      ) : null}
      {shouldRenderColumns ? (
        <div className="lineage-node-body nowheel nodrag" onWheelCapture={(event) => event.stopPropagation()}>
          {data.collapsedGroup ? (
            <CollapsedGroupBody data={data} nodeId={node.id} />
          ) : node.columns.length > 0 ? (
            <LineageColumnList columns={node.columns} data={data} forceOnly={!columnsVisible && !columnsExpanded} nodeId={node.id} />
          ) : (
            <div className="lineage-column lineage-column-muted">columns unresolved</div>
          )}
        </div>
      ) : null}
      <Handle className="lineage-node-handle lineage-node-handle-source" type="source" position={Position.Right} />
    </div>
  );
}

function formatNodeKind(type: GraphNode['data']['lineageNode']['type']) {
  if (type === 'parameter_table') return 'Param';
  return type === 'scalar_subquery' ? 'Scalar' : type;
}

function PopulationImpactBadges({ labels }: { labels: string[] }) {
  return (
    <div className="lineage-node-impact-badges" aria-label={`Focus row-lineage signals to inspect: ${labels.join(', ')}`}>
      {labels.map((label) => (
        <span key={label} title="Focus symptom signal on the node that owns this row-lineage operation">
          {label}
        </span>
      ))}
    </div>
  );
}

function SourceDataBadges({ labels }: { labels: string[] }) {
  const visibleLabels = labels.slice(0, 2);
  const overflowCount = labels.length - visibleLabels.length;

  return (
    <div className="lineage-node-source-data-badges" aria-label={`Source data used by the selected value lineage: ${labels.join(', ')}`}>
      {visibleLabels.map((label) => (
        <span key={label} title="Source data used by the selected value lineage">
          {label}
        </span>
      ))}
      {overflowCount > 0 ? <span>+{overflowCount}</span> : null}
    </div>
  );
}

function ReferenceBadges({ labels }: { labels: string[] }) {
  const visibleLabels = labels.slice(0, 2);
  const overflowCount = labels.length - visibleLabels.length;

  return (
    <div className="lineage-node-reference-badges" aria-label={`Referenced by the selected row-lineage signal: ${labels.join(', ')}`}>
      {visibleLabels.map((label) => (
        <span key={label} title="This source is referenced by the highlighted condition or population signal">
          {label}
        </span>
      ))}
      {overflowCount > 0 ? <span>+{overflowCount}</span> : null}
    </div>
  );
}

function GroupPopulationImpactBadges({
  group,
  highlightedLabels,
}: {
  group: NonNullable<GraphNode['data']['collapsedGroup']>;
  highlightedLabels?: Map<string, string[]>;
}) {
  const highlightedBadges = highlightedLabels
    ? [
        ...uniqueStrings(highlightedLabels.get(group.rootNodeId) ?? []).map((label) => ({ label, origin: 'Self' as const })),
        ...uniqueStrings(group.helperNodeIds.flatMap((nodeId) => highlightedLabels.get(nodeId) ?? [])).map((label) => ({ label, origin: 'Hidden' as const })),
      ]
    : [];
  const badges = uniqueBadgesByLabel(highlightedBadges);
  if (badges.length === 0) {
    return null;
  }

  const ariaLabel = badges.map((badge) => `${badge.origin}: ${badge.label}`).join(', ');

  return (
    <div className="lineage-node-impact-badges" aria-label={`Population impacts: ${ariaLabel}`}>
      {badges.map((badge) => {
        return (
          <span
            className={badge.origin === 'Self' ? 'lineage-node-impact-self' : 'lineage-node-impact-descendant'}
            key={`${badge.origin}-${badge.label}`}
            title={`${badge.origin === 'Self' ? 'Group self effect' : 'Hidden descendant effect'}: ${badge.label}`}
          >
            {badge.label}
          </span>
        );
      })}
    </div>
  );
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function uniqueBadgesByLabel<T extends { label: string }>(badges: T[]) {
  const uniqueBadges = new Map<string, T>();
  for (const badge of badges) {
    if (!uniqueBadges.has(badge.label)) {
      uniqueBadges.set(badge.label, badge);
    }
  }
  return [...uniqueBadges.values()];
}

function CollapsedGroupBody({ data, nodeId }: { data: GraphNode['data']; nodeId: string }) {
  const group = data.collapsedGroup;
  if (!group) {
    return null;
  }

  return (
    <div className="lineage-group-summary">
      {data.lineageNode.columns.length > 0 ? (
        <LineageColumnList
          columns={data.lineageNode.columns}
          data={data}
          forceOnly={data.columnsVisible === false && data.selectedNodeId !== nodeId}
          nodeId={nodeId}
        />
      ) : (
        <div className="lineage-column lineage-column-muted">columns unresolved</div>
      )}
    </div>
  );
}

function LineageColumnList({
  columns,
  data,
  forceOnly = false,
  nodeId,
}: {
  columns: GraphNode['data']['lineageNode']['columns'];
  data: GraphNode['data'];
  forceOnly?: boolean;
  nodeId: string;
}) {
  const isOutputNode = data.lineageNode.type === 'output';
  const nodeExpanded = data.selectedNodeId === nodeId || columns.some((column) => column.id === data.originSelectedColumnId);
  const shouldCompress = !isOutputNode && !nodeExpanded && (data.passthroughColumnsCompressed ?? false);
  const baseColumns = !isOutputNode && forceOnly ? columns.filter((column) => data.forcedVisibleColumnIds?.has(column.id)) : columns;
  const displayColumns = nodeExpanded ? baseColumns : baseColumns.filter(isVisibleGraphColumn);
  const visibleColumns = shouldCompress ? displayColumns.filter((column) => !isCompressedPassthroughColumn(column, data)) : displayColumns;
  const compressedCount = shouldCompress ? displayColumns.length - visibleColumns.length : 0;

  return (
    <>
      {visibleColumns.map((column) => (
        <LineageColumnRow column={column} data={data} key={column.id} nodeId={nodeId} />
      ))}
      {compressedCount > 0 ? <PassthroughSummary count={compressedCount} /> : null}
    </>
  );
}

function isCompressedPassthroughColumn(column: GraphNode['data']['lineageNode']['columns'][number], data: GraphNode['data']) {
  return (
    isPassthroughColumn(column) &&
    data.selectedColumnId !== column.id &&
    !(data.activeLineageRootColumnIds?.has(column.id) ?? false) &&
    !(data.highlightedColumnIds?.has(column.id) ?? false) &&
    !(data.sourceColumnIds?.has(column.id) ?? false) &&
    !(data.forcedVisibleColumnIds?.has(column.id) ?? false) &&
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
  const isActiveRoot = data.activeLineageRootColumnIds?.has(column.id) ?? false;
  const hasSelectedMarker = isSelected || isActiveRoot;
  const isCommentSelected = data.selectedCommentTargetIds?.has(columnCommentTargetId(column.id)) ?? false;
  const isSource = data.sourceColumnIds?.has(column.id) ?? false;
  const isHighlighted = data.highlightedColumnIds?.has(column.id) ?? false;
  const selectedRuleExpressionSql = data.selectedRuleExpressionByColumnId?.get(column.id);
  const expressionSql =
    selectedRuleExpressionSql ??
    (column.expressionSql && (isSelected || !isSimpleColumnReference(column.expressionSql)) ? column.expressionSql : undefined);
  const fallbackText = isSelected && !column.comments?.length && !expressionSql && !formatUsageText(column) ? column.name : undefined;
  return (
    <div className="lineage-column-group">
      <button
        ref={columnRef}
        className={`lineage-column ${hasSelectedMarker ? 'lineage-column-selected' : ''} ${isSource ? 'lineage-column-source' : ''} ${isHighlighted ? 'lineage-column-highlighted' : ''} ${isCommentSelected ? 'lineage-comment-selected' : ''} nodrag`}
        onClick={(event) => {
          event.stopPropagation();
          data.onColumnSelect?.(nodeId, column);
        }}
        type="button"
      >
        {hasSelectedMarker ? <Check className="lineage-column-selected-icon" size={12} strokeWidth={3} aria-hidden="true" /> : null}
        <span className="lineage-column-label">{column.name}</span>
      </button>
      {isCommentSelected && (isSelected || hasColumnCalloutContent(column) || selectedRuleExpressionSql) ? (
        <CommentBubble
          anchorRef={columnRef}
          comments={column.comments}
          expressionSql={expressionSql}
          fallbackText={fallbackText}
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
  fallbackText,
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
  fallbackText?: string;
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
      {fallbackText ? <div className="lineage-comment-section">{fallbackText}</div> : null}
      {expressionSql ? (
        <div className="lineage-comment-section">
          <SqlCodeMirror className="lineage-expression" value={expressionSql} />
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
  if (column.usage?.role === 'filter') {
    return 'Filter';
  }
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
  url.hash = new URLSearchParams({ sql, history: '0' }).toString();
  return url.toString();
}

function getNodeSql(node: GraphNode['data']['lineageNode']): string | undefined {
  return node.querySql ?? node.cteExecutableSql;
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
