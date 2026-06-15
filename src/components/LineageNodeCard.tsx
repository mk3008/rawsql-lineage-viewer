import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Database, Eye, EyeOff, FileJson2, GitBranch, Table2 } from 'lucide-react';
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
      {data.selectedCommentTargetIds?.has(nodeCommentTargetId(node.id)) && node.comments && node.comments.length > 0 ? (
        <CommentBubble comments={node.comments} variant="node" />
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

function CommentBubble({ comments, expressionSql, variant }: { comments?: string[]; expressionSql?: string; variant: 'column' | 'node' }) {
  return (
    <div className={`lineage-comment-bubble lineage-comment-bubble-${variant} nodrag`} data-testid="lineage-comment">
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
    </div>
  );
}

function nodeCommentTargetId(nodeId: string) {
  return `node:${nodeId}`;
}

function columnCommentTargetId(columnId: string) {
  return `column:${columnId}`;
}
