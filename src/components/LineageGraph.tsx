import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import type { EdgeVisibility } from '../domain/graph';
import type { LineageModel } from '../domain/lineage';
import { buildGraphModel } from '../graph/buildGraphModel';
import { LineageNodeCard } from './LineageNodeCard';

const nodeTypes = {
  lineageNode: LineageNodeCard,
};

export function LineageGraph({ lineage, edgeVisibility }: { lineage: LineageModel; edgeVisibility: EdgeVisibility }) {
  const graph = useMemo(() => buildGraphModel(lineage, { dataFlow: true, join: true }), [lineage]);
  const visibleEdges = useMemo(
    () =>
      graph.edges.filter((edge) => {
        const type = edge.data?.lineageEdge.type;
        return (type === 'dataFlow' && edgeVisibility.dataFlow) || (type === 'join' && edgeVisibility.join) || (type !== 'dataFlow' && type !== 'join');
      }),
    [edgeVisibility, graph.edges],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(visibleEdges);

  useEffect(() => {
    setNodes(graph.nodes);
  }, [graph.nodes, setNodes]);

  useEffect(() => {
    setEdges(visibleEdges);
  }, [setEdges, visibleEdges]);

  return (
    <div className="graph-shell" data-testid="lineage-graph">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodesDraggable
          nodesConnectable={false}
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
