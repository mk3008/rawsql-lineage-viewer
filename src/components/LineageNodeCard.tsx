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
    <div className={`lineage-node lineage-node-${node.type}`} data-testid={`lineage-node-${node.type}`}>
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
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
