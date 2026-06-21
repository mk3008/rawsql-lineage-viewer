import type { CandidateConcern, ColumnDiagnosticPacket, PopulationEffect, PopulationInfluence } from './diagnostics';
import { populationSignalOrder, symptomEffectMap, symptomMechanismMap, type DiagnosticConcernEffect, type PopulationSignal, type ProblemIntent } from './problemIntent';

export type ProblemIntentMatchStrength = 'matched' | 'related' | 'unmatched';

export interface ProblemIntentBadge {
  label: string;
  signal: PopulationSignal;
  strength: ProblemIntentMatchStrength;
}

export interface ProblemIntentConcern extends CandidateConcern {
  intentMatchStrength: ProblemIntentMatchStrength;
  matchedEffectsForIntent: DiagnosticConcernEffect[];
}

export function populationSignalLabel(signal: PopulationSignal): string {
  switch (signal) {
    case 'where':
      return 'Where';
    case 'having':
      return 'Having';
    case 'join_xn':
      return 'Join xN';
    case 'outer_join':
      return 'Outer Join';
    case 'group_by':
      return 'Group By';
    case 'limit':
      return 'Limit';
    case 'order_by':
      return 'Order By';
  }
}

export function valueEffectLabel(effect: DiagnosticConcernEffect): string | null {
  switch (effect) {
    case 'aggregate_expression':
    case 'grain_change':
      return 'Agg';
    case 'case_when':
      return 'Case';
    case 'null_replacement':
      return 'Coalesce';
    case 'function_call':
    case 'source_data_value':
    case 'value_transform':
      return 'Expr';
    default:
      return null;
  }
}

export function problemIntentBadgesForEffects(effects: PopulationEffect[], intent: ProblemIntent, signals: PopulationSignal[] = []): ProblemIntentBadge[] {
  if (intent === 'logic_review') {
    return [];
  }

  const visibleSignals = signals.length > 0 ? uniquePopulationSignals(signals) : signalsFromEffects(effects);
  return visibleSignals
    .map((signal): ProblemIntentBadge => {
      const badge: ProblemIntentBadge = {
        label: populationSignalLabel(signal),
        signal,
        strength: intent === 'all_signals' || populationSignalMatchesIntent(signal, effects, intent) ? 'matched' : 'related',
      };
      return badge;
    })
    .filter((badge) => badge.strength === 'matched');
}

export function populationImpactLabelsByNodeIdForIntent(packet: ColumnDiagnosticPacket, intent: ProblemIntent): Record<string, string[]> {
  if (intent === 'logic_review') {
    return {};
  }

  return Object.fromEntries(
    packet.populationOrigin.nodeImpacts
      .map((nodeImpact) => [
        nodeImpact.nodeId,
        uniqueLabels(problemIntentBadgesForEffects(nodeImpact.effects, intent, nodeImpact.signals).map((badge) => badge.label)),
      ])
      .filter(([, labels]) => labels.length > 0),
  );
}

export function sourceDataValueLabelsByNodeIdForIntent(packet: ColumnDiagnosticPacket, intent: ProblemIntent): Record<string, string[]> {
  if (intent === 'logic_review') {
    return {};
  }

  const hasSourceDataConcern = packet.candidateConcerns.some((concern) =>
    concern.kind === 'source_data_value' && concern.effects.some((effect) => symptomEffectMap[intent].includes(effect)),
  );
  if (!hasSourceDataConcern) {
    return {};
  }

  const entries = new Map<string, string[]>();
  for (const source of packet.valueOrigin.sourceLeaves) {
    entries.set(source.nodeId, uniqueLabels([...(entries.get(source.nodeId) ?? []), 'Data?']));
  }
  return Object.fromEntries(entries);
}

export function filterPopulationInfluencesForIntent(influences: PopulationInfluence[], intent: ProblemIntent): PopulationInfluence[] {
  if (intent === 'logic_review') {
    return [];
  }
  if (intent === 'all_signals') {
    return influences;
  }

  const expectedEffects = symptomEffectMap[intent];
  const expectedMechanisms = symptomMechanismMap[intent];
  return influences.filter((influence) =>
    influence.effects.some((effect) => expectedEffects.includes(effect))
    || influence.signals.some((signal) => populationSignalMatchesIntent(signal, influence.effects, intent))
    || expectedMechanisms.includes(influence.mechanism),
  );
}

export function rankCandidateConcernsForIntent(concerns: CandidateConcern[], intent: ProblemIntent): ProblemIntentConcern[] {
  const expectedEffects = symptomEffectMap[intent];
  const expectedMechanisms = symptomMechanismMap[intent];

  return concerns
    .map((concern, originalIndex) => {
      const matchedEffects = concern.effects.filter((effect) => expectedEffects.includes(effect));
      const matchedMechanismCount = concern.mechanisms.filter((mechanism) => expectedMechanisms.includes(mechanism)).length;
      const intentMatchStrength: ProblemIntentMatchStrength =
        matchedEffects.length > 0 ? 'matched' : matchedMechanismCount > 0 ? 'related' : 'unmatched';
      return {
        ...concern,
        intentMatchStrength,
        matchedEffectsForIntent: matchedEffects,
        originalIndex,
      };
    })
    .filter((concern) => intent === 'logic_review' ? concern.intentMatchStrength !== 'unmatched' : concern.intentMatchStrength === 'matched')
    .sort((left, right) => {
      const strengthDelta = strengthRank(right.intentMatchStrength) - strengthRank(left.intentMatchStrength);
      if (strengthDelta !== 0) {
        return strengthDelta;
      }
      const effectDelta = right.matchedEffectsForIntent.length - left.matchedEffectsForIntent.length;
      if (effectDelta !== 0) {
        return effectDelta;
      }
      return left.originalIndex - right.originalIndex;
    })
    .map(({ originalIndex, ...concern }) => {
      void originalIndex;
      return concern;
    });
}

export function targetIsPopulationIntent(intent: ProblemIntent): boolean {
  return intent !== 'logic_review';
}

function populationEffectMatchesIntent(effect: PopulationEffect, intent: ProblemIntent): boolean {
  return symptomEffectMap[intent].includes(effect);
}

function populationSignalMatchesIntent(signal: PopulationSignal, effects: PopulationEffect[], intent: ProblemIntent): boolean {
  return signalEffects(signal).some((effect) => effects.includes(effect) && populationEffectMatchesIntent(effect, intent));
}

function signalEffects(signal: PopulationSignal): PopulationEffect[] {
  switch (signal) {
    case 'where':
    case 'having':
      return ['row_filter'];
    case 'join_xn':
      return ['row_filter', 'row_multiplication'];
    case 'outer_join':
      return ['null_extension'];
    case 'group_by':
      return ['grain_change'];
    case 'limit':
      return ['output_cap'];
    case 'order_by':
      return ['output_selection'];
  }
}

function strengthRank(strength: ProblemIntentMatchStrength) {
  switch (strength) {
    case 'matched':
      return 2;
    case 'related':
      return 1;
    case 'unmatched':
      return 0;
  }
}

function uniquePopulationEffects(effects: PopulationEffect[]): PopulationEffect[] {
  return [...new Set(effects)];
}

function signalsFromEffects(effects: PopulationEffect[]): PopulationSignal[] {
  const signals: PopulationSignal[] = [];
  for (const effect of uniquePopulationEffects(effects)) {
    switch (effect) {
      case 'row_filter':
        signals.push('where');
        break;
      case 'row_multiplication':
        signals.push('join_xn');
        break;
      case 'grain_change':
        signals.push('group_by');
        break;
      case 'null_extension':
        signals.push('outer_join');
        break;
      case 'output_cap':
        signals.push('limit');
        break;
      case 'output_selection':
        signals.push('order_by');
        break;
    }
  }
  return uniquePopulationSignals(signals);
}

function uniquePopulationSignals(signals: PopulationSignal[]): PopulationSignal[] {
  const unique = new Set(signals);
  return populationSignalOrder.filter((signal) => unique.has(signal));
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels)];
}
