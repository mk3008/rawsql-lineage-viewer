import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { useMemo } from 'react';
import type { EdgeVisibility } from '../domain/graph';
import type { LineageModel } from '../domain/lineage';
import { buildGraphModel } from '../graph/buildGraphModel';
import { LineageNodeCard } from './LineageNodeCard';

const nodeTypes = {
  lineageNode: LineageNodeCard,
};

export function LineageGraph({ lineage, edgeVisibility }: { lineage: LineageModel; edgeVisibility: EdgeVisibility }) {
  const graph = useMemo(() => buildGraphModel(lineage, edgeVisibility), [edgeVisibility, lineage]);

  return (
    <div className="graph-shell" data-testid="lineage-graph">
      <ReactFlowProvider>
        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.35}
          maxZoom={1.6}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#d7deea" gap={18} size={1} />
          <Controls position="top-right" showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(node) => {
              const type = (node.data as { lineageNode?: { type?: string } } | undefined)?.lineageNode?.type;
              if (type === 'table') return '#dbeafe';
              if (type === 'cte') return '#dcfce7';
              if (type === 'output') return '#f3e8ff';
              return '#fef3c7';
            }}
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
