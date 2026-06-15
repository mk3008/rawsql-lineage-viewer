import type { AnalysisWarning, LineageEdge, LineageModel, LineageNode, LineageNodeType } from '../domain/lineage';

type IntermediateNode = {
  id: string;
  label: string;
  shape: 'table' | 'cte' | 'derived' | 'output' | 'join' | 'process';
};

type IntermediateEdge = {
  source: string;
  target: string;
  label?: string;
};

const nodePatterns = [
  /^(?<id>[A-Za-z0-9_]+)\[\(CTE:(?<label>.+?)\)\]$/,
  /^(?<id>[A-Za-z0-9_]+)\[\((?<label>.+?)\)\]$/,
  /^(?<id>[A-Za-z0-9_]+)\{\{SubQuery:(?<label>.+?)\}\}$/,
  /^(?<id>[A-Za-z0-9_]+)\(\[(?<label>.+?)\]\)$/,
  /^(?<id>[A-Za-z0-9_]+)\[(?<label>.+?)\]$/,
];

export function parseMermaidFlow(mermaid: string, warnings: AnalysisWarning[] = []): LineageModel {
  const intermediateNodes = new Map<string, IntermediateNode>();
  const intermediateEdges: IntermediateEdge[] = [];

  for (const rawLine of mermaid.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('flowchart') || line.startsWith('%%')) {
      continue;
    }

    const edge = parseEdge(line);
    if (edge) {
      intermediateEdges.push(edge);
      continue;
    }

    const node = parseNode(line);
    if (node) {
      intermediateNodes.set(node.id, node);
    }
  }

  const joinNodes = new Map(
    [...intermediateNodes.values()]
      .filter((node) => node.shape === 'join')
      .map((node) => [node.id, node]),
  );

  const nodes = [...intermediateNodes.values()]
    .filter((node) => node.shape !== 'join' && node.shape !== 'process')
    .map(toLineageNode);

  const nodeIds = new Set(nodes.map((node) => node.id));
  const incomingByJoin = new Map<string, IntermediateEdge[]>();
  for (const edge of intermediateEdges) {
    if (joinNodes.has(edge.target)) {
      incomingByJoin.set(edge.target, [...(incomingByJoin.get(edge.target) ?? []), edge]);
    }
  }

  const lineageEdges: LineageEdge[] = [];
  for (const edge of intermediateEdges) {
    const targetJoin = joinNodes.get(edge.target);
    if (targetJoin) {
      continue;
    }

    const sourceJoin = joinNodes.get(edge.source);
    if (sourceJoin) {
      const incoming = incomingByJoin.get(sourceJoin.id) ?? [];
      for (const inputEdge of incoming) {
        if (!nodeIds.has(inputEdge.source) || !nodeIds.has(edge.target)) {
          continue;
        }
        lineageEdges.push({
          id: `${inputEdge.source}-${edge.target}-${sourceJoin.id}`,
          source: inputEdge.source,
          target: edge.target,
          type: 'join',
          label: sourceJoin.label,
          joinType: normalizeJoinType(sourceJoin.label),
          confidence: 'medium',
        });
      }
      continue;
    }

    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      warnings.push({
        code: 'edge-endpoint-skipped',
        message: `Skipped unresolved graph edge ${edge.source} -> ${edge.target}.`,
      });
      continue;
    }

    lineageEdges.push({
      id: `${edge.source}-${edge.target}`,
      source: edge.source,
      target: edge.target,
      type: 'dataFlow',
      label: edge.label,
      confidence: 'high',
    });
  }

  return {
    kind: 'sql-lineage-model',
    modelVersion: 1,
    nodes,
    edges: dedupeEdges(lineageEdges),
    analysisWarnings: warnings,
    raw: {
      mermaid,
    },
  };
}

function parseNode(line: string): IntermediateNode | null {
  for (const pattern of nodePatterns) {
    const match = line.match(pattern);
    const groups = match?.groups;
    if (!groups?.id || !groups?.label) {
      continue;
    }
    const label = groups.label.trim();
    return {
      id: groups.id,
      label,
      shape: inferShape(groups.id, label, line),
    };
  }
  return null;
}

function parseEdge(line: string): IntermediateEdge | null {
  const labelled = line.match(/^(?<source>[A-Za-z0-9_]+)\s*-->\|(?<label>.+?)\|\s*(?<target>[A-Za-z0-9_]+)$/);
  if (labelled?.groups) {
    return {
      source: labelled.groups.source,
      target: labelled.groups.target,
      label: labelled.groups.label.trim(),
    };
  }

  const plain = line.match(/^(?<source>[A-Za-z0-9_]+)\s*-->\s*(?<target>[A-Za-z0-9_]+)$/);
  if (plain?.groups) {
    return {
      source: plain.groups.source,
      target: plain.groups.target,
    };
  }

  return null;
}

function inferShape(id: string, label: string, rawLine: string): IntermediateNode['shape'] {
  if (id.startsWith('table_')) {
    return 'table';
  }
  if (id.startsWith('cte_')) {
    return 'cte';
  }
  if (id.includes('output') || label.toLowerCase().includes('final result')) {
    return 'output';
  }
  if (id.startsWith('join_') || /\bJOIN\b/i.test(label)) {
    return 'join';
  }
  if (rawLine.includes('{{')) {
    return 'derived';
  }
  if (/\bUNION\b|\bINTERSECT\b|\bEXCEPT\b/i.test(label)) {
    return 'derived';
  }
  return 'process';
}

function toLineageNode(node: IntermediateNode): LineageNode {
  const type = normalizeNodeType(node.shape);
  return {
    id: node.id,
    type,
    label: node.label,
    columns: [],
    materializationHint: type === 'cte' ? 'none' : undefined,
  };
}

function normalizeNodeType(shape: IntermediateNode['shape']): LineageNodeType {
  if (shape === 'table' || shape === 'cte' || shape === 'derived' || shape === 'output') {
    return shape;
  }
  return 'derived';
}

function normalizeJoinType(label: string): LineageEdge['joinType'] {
  const normalized = label.toLowerCase();
  if (normalized.includes('left')) {
    return 'left';
  }
  if (normalized.includes('right')) {
    return 'right';
  }
  if (normalized.includes('full')) {
    return 'full';
  }
  if (normalized.includes('join')) {
    return 'inner';
  }
  return 'unknown';
}

function dedupeEdges(edges: LineageEdge[]): LineageEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}|${edge.target}|${edge.type}|${edge.label ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
