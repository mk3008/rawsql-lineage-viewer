import type { CandidateConcern, ColumnDiagnosticPacket, DiagnosticSourceReference } from './diagnostics';

export function renderDiagnosticPacketText(packet: ColumnDiagnosticPacket): string {
  return [
    `Target: ${packet.target.columnName} (${packet.target.nodeType}: ${packet.target.nodeLabel})`,
    '',
    renderColumnLineageText(packet),
    '',
    renderRowLineageText(packet),
    '',
    renderCandidateConcernsText(packet),
  ].join('\n');
}

export function renderColumnLineageText(packet: ColumnDiagnosticPacket): string {
  const lines = ['Column Lineage:'];
  lines.push(`- ${formatColumnLineageSummary(packet.columnLineage.summary)}`);
  if (packet.columnLineage.expressionChain.length > 0) {
    lines.push('- Expressions:');
    for (const expression of packet.columnLineage.expressionChain) {
      lines.push(`  - ${expression.nodeId}.${expression.columnName}: ${oneLine(expression.expressionSql)}`);
    }
  }
  if (packet.columnLineage.caseRules.length > 0) {
    lines.push('- CASE rules:');
    for (const rule of packet.columnLineage.caseRules) {
      lines.push(`  - ${rule.label}`);
      if (rule.conditionSql) {
        lines.push(`    condition: ${oneLine(rule.conditionSql)}`);
      }
      if (rule.resultSql) {
        lines.push(`    result: ${oneLine(rule.resultSql)}`);
      }
    }
  }
  if (packet.columnLineage.references.length > 0) {
    lines.push('- References:');
    for (const reference of packet.columnLineage.references) {
      lines.push(`  - ${formatReference(reference)}`);
    }
  }
  if (packet.columnLineage.sourceLeaves.length > 0) {
    lines.push('- Source leaves:');
    for (const source of packet.columnLineage.sourceLeaves) {
      lines.push(`  - ${source.nodeLabel}.${source.columnName} (${source.nodeType})`);
    }
  }
  return lines.join('\n');
}

export function renderRowLineageText(packet: ColumnDiagnosticPacket): string {
  const lines = ['Row Lineage:'];
  lines.push(`- ${packet.rowLineage.summary}`);
  if (packet.rowLineage.influences.length > 0) {
    lines.push('- Influences:');
    for (const influence of packet.rowLineage.influences) {
      lines.push(`  - ${influence.mechanism}: ${oneLine(influence.expressionSql)}`);
      if (influence.references.length > 0) {
        lines.push(`    refs: ${influence.references.map(formatReference).join(', ')}`);
      }
      lines.push(`    effects: ${influence.effects.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function renderCandidateConcernsText(packet: ColumnDiagnosticPacket): string {
  const lines = ['Candidate concerns:'];
  if (packet.candidateConcerns.length === 0) {
    lines.push('- None.');
    return lines.join('\n');
  }
  for (const concern of packet.candidateConcerns) {
    lines.push(`- ${formatConcern(concern)}`);
  }
  return lines.join('\n');
}

function formatConcern(concern: CandidateConcern): string {
  const evidence = concern.evidence.length > 0 ? ` evidence: ${concern.evidence.map(oneLine).join(' | ')}` : '';
  return `${concern.kind} (${concern.confidence}): ${concern.reason}${evidence}`;
}

function formatReference(reference: DiagnosticSourceReference): string {
  return `${reference.nodeLabel}.${reference.columnName} [${reference.roles.join(', ')}]`;
}

function formatColumnLineageSummary(summary: ColumnDiagnosticPacket['columnLineage']['summary']): string {
  if (summary.sourceLeafCount === 0) {
    return 'No upstream column lineage source leaves were found for this target.';
  }
  return [
    `${summary.sourceLeafCount} source leaf column(s)`,
    `${summary.intermediateReferenceCount} intermediate reference(s)`,
    `${summary.expressionStepCount} expression step(s)`,
    `${summary.caseRuleCount} CASE rule(s)`,
  ].join(', ');
}

function oneLine(value?: string): string {
  return value?.replace(/\s+/g, ' ').trim() || '(none)';
}
