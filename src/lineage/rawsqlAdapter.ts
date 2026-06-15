import { QueryFlowDiagramGenerator, SelectQueryParser } from 'rawsql-ts';
import type { AnalysisWarning, LineageModel } from '../domain/lineage';
import { parseMermaidFlow } from './mermaidFlowParser';

export interface ParserAdapterResult {
  lineage: LineageModel;
  parserVersion: string;
}

const parserVersion = 'rawsql-ts';

export function analyzeSql(sql: string): ParserAdapterResult {
  const warnings: AnalysisWarning[] = [];

  try {
    SelectQueryParser.parse(sql);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const mermaid = new QueryFlowDiagramGenerator().generateMermaidFlow(sql, {
    direction: 'LR',
  });
  const lineage = parseMermaidFlow(mermaid, warnings);

  if (lineage.nodes.every((node) => node.type !== 'output')) {
    warnings.push({
      code: 'output-not-found',
      message: 'The parser did not expose an output node for this query.',
    });
  }

  return {
    lineage: {
      ...lineage,
      analysisWarnings: warnings,
    },
    parserVersion,
  };
}
