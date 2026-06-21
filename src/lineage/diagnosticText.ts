import type { CandidateConcern, ColumnDiagnosticPacket, DiagnosticSourceReference } from './diagnostics';

export function renderDiagnosticPacketText(packet: ColumnDiagnosticPacket): string {
  return [
    `Target: ${packet.target.columnName} (${packet.target.nodeType}: ${packet.target.nodeLabel})`,
    '',
    renderValueOriginText(packet),
    '',
    renderPopulationOriginText(packet),
    '',
    renderCandidateConcernsText(packet),
  ].join('\n');
}

export function renderValueOriginText(packet: ColumnDiagnosticPacket): string {
  const lines = ['Value origin:'];
  lines.push(`- ${formatValueOriginSummary(packet.valueOrigin.summary)}`);
  if (packet.valueOrigin.expressionChain.length > 0) {
    lines.push('- Expressions:');
    for (const expression of packet.valueOrigin.expressionChain) {
      lines.push(`  - ${expression.nodeId}.${expression.columnName}: ${oneLine(expression.expressionSql)}`);
    }
  }
  if (packet.valueOrigin.caseRules.length > 0) {
    lines.push('- CASE rules:');
    for (const rule of packet.valueOrigin.caseRules) {
      lines.push(`  - ${rule.label}`);
      if (rule.conditionSql) {
        lines.push(`    condition: ${oneLine(rule.conditionSql)}`);
      }
      if (rule.resultSql) {
        lines.push(`    result: ${oneLine(rule.resultSql)}`);
      }
    }
  }
  if (packet.valueOrigin.references.length > 0) {
    lines.push('- References:');
    for (const reference of packet.valueOrigin.references) {
      lines.push(`  - ${formatReference(reference)}`);
    }
  }
  if (packet.valueOrigin.sourceLeaves.length > 0) {
    lines.push('- Source leaves:');
    for (const source of packet.valueOrigin.sourceLeaves) {
      lines.push(`  - ${source.nodeLabel}.${source.columnName} (${source.nodeType})`);
    }
  }
  return lines.join('\n');
}

export function renderPopulationOriginText(packet: ColumnDiagnosticPacket): string {
  const lines = ['Population origin:'];
  lines.push(`- ${packet.populationOrigin.summary}`);
  if (packet.populationOrigin.influences.length > 0) {
    lines.push('- Influences:');
    for (const influence of packet.populationOrigin.influences) {
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

function formatValueOriginSummary(summary: ColumnDiagnosticPacket['valueOrigin']['summary']): string {
  if (summary.sourceLeafCount === 0) {
    return 'No upstream value-origin source leaves were found for this target.';
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
