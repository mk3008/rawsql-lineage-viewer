import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Database, FileJson2, GitBranch, Table2 } from 'lucide-react';
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

  return (
    <div className={`lineage-node lineage-node-${node.type}`} data-testid={`lineage-node-${node.type}`}>
      <Handle type="target" position={Position.Left} />
      <div className="lineage-node-header">
        <span className="lineage-node-title">
          <Icon size={15} aria-hidden="true" />
          {node.label}
        </span>
        <span className="lineage-node-kind">{node.type}</span>
      </div>
      <div className="lineage-node-body">
        {node.columns.length > 0 ? (
          node.columns.map((column) => (
            <div className="lineage-column" key={column.id}>
              {column.name}
            </div>
          ))
        ) : (
          <div className="lineage-column lineage-column-muted">columns unresolved</div>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
