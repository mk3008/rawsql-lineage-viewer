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
  const nodeStyle = data.nodeHeight && columnsVisible ? { height: data.nodeHeight } : undefined;

  return (
    <div
      className={`lineage-node lineage-node-${node.type} ${columnsVisible ? 'lineage-node-expanded' : 'lineage-node-collapsed'} ${data.nodeHeight ? 'lineage-node-resized' : ''}`}
      data-testid={`lineage-node-${node.type}`}
      style={nodeStyle}
    >
      <Handle type="target" position={Position.Left} />
      <div className="lineage-node-header">
        <span className="lineage-node-title">
          <Icon size={15} aria-hidden="true" />
          {node.label}
        </span>
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
      {columnsVisible ? (
        <div className="lineage-node-body">
          {node.columns.length > 0 ? (
            node.columns.map((column) => {
              const isSelected = data.selectedColumnId === column.id;
              const isSource = data.sourceColumnIds?.has(column.id) ?? false;
              const isHighlighted = data.highlightedColumnIds?.has(column.id) ?? false;
              return (
                <button
                  className={`lineage-column ${isSelected ? 'lineage-column-selected' : ''} ${isSource ? 'lineage-column-source' : ''} ${isHighlighted ? 'lineage-column-highlighted' : ''} nodrag`}
                  key={column.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    data.onColumnSelect?.(node.id, column);
                  }}
                  type="button"
                >
                  {column.name}
                </button>
              );
            })
          ) : (
            <div className="lineage-column lineage-column-muted">columns unresolved</div>
          )}
        </div>
      ) : null}
      {columnsVisible ? (
        <div
          aria-label={`Resize ${node.label} height`}
          className="lineage-node-resize nodrag"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const startY = event.clientY;
            const startHeight = event.currentTarget.parentElement?.offsetHeight ?? data.nodeHeight ?? 210;

            const onMouseMove = (moveEvent: MouseEvent) => {
              data.onNodeResize?.(node.id, Math.max(118, Math.min(520, startHeight + moveEvent.clientY - startY)));
            };
            const onMouseUp = () => {
              window.removeEventListener('mousemove', onMouseMove);
              window.removeEventListener('mouseup', onMouseUp);
            };

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
          }}
          role="separator"
        />
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
