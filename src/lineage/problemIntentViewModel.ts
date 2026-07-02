import type { CandidateConcern, ColumnDiagnosticPacket, PopulationEffect, PopulationInfluence } from './diagnostics';
import { populationSignalOrder, symptomEffectMap, symptomMechanismMap, type DiagnosticConcernEffect, type PopulationSignal, type ProblemIntent } from './problemIntent';

export type ProblemIntentMatchStrength = 'matched' | 'related' | 'unmatched';

export interface ProblemIntentBadge {
  label: string;
  signal: PopulationSignal;
  strength: ProblemIntentMatchStrength;
}

type GraphPopulationSignal = Exclude<PopulationSignal, 'order_by'> | 'top_n';

interface GraphFocusBadge {
  label: string;
  signal: GraphPopulationSignal;
  strength: ProblemIntentMatchStrength;
}

export interface ProblemIntentConcern extends CandidateConcern {
  intentMatchStrength: ProblemIntentMatchStrength;
  matchedEffectsForIntent: DiagnosticConcernEffect[];
}

export function populationSignalLabel(signal: PopulationSignal): string {
  switch (signal) {
    case 'distinct':
      return 'Distinct';
    case 'distinct_on':
      return 'Distinct On';
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

function graphPopulationSignalLabel(signal: GraphPopulationSignal): string {
  switch (signal) {
    case 'top_n':
      return 'Top-N';
    default:
      return populationSignalLabel(signal);
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

  const influencesById = new Map(packet.rowLineage.influences.map((influence) => [influence.id, influence]));
  return Object.fromEntries(
    packet.rowLineage.nodeImpacts
      .map((nodeImpact) => {
        const impactInfluences = nodeImpact.influenceIds
          .map((influenceId) => influencesById.get(influenceId))
          .filter((influence): influence is PopulationInfluence => Boolean(influence));
        const labels = impactInfluences.length > 0
          ? uniqueLabels(impactInfluences.flatMap((influence) => graphImpactBadgesForInfluence(influence, packet.rowLineage.influences, intent).map((badge) => badge.label)))
          : uniqueLabels(graphFocusBadgesForEffects(nodeImpact.effects, intent, nodeImpact.signals, nodeImpactHasTopN(nodeImpact.signals)).map((badge) => badge.label));
        return [nodeImpact.nodeId, labels] as const;
      })
      .filter(([, labels]) => labels.length > 0),
  );
}

/**
 * Graph focus badges are diagnostic annotations, not a SQL syntax inventory.
 *
 * Yellow: the node that owns a row-lineage signal worth inspecting for the selected Focus.
 * Blue: input nodes referenced by that highlighted condition/population signal.
 * Purple: source data used by the selected value lineage.
 *
 * Keep raw diagnostic influences such as `order_by`; this layer only decides which
 * compact graph badges are visible for the selected column + Focus symptom.
 */
export function graphImpactBadgesForInfluence(
  influence: PopulationInfluence,
  allInfluences: PopulationInfluence[],
  intent: ProblemIntent,
): GraphFocusBadge[] {
  return graphFocusBadgesForEffects(influence.effects, intent, influence.signals, influenceScopeHasTopN(allInfluences, influence.scopeId));
}

export function graphReferenceLabelsForInfluence(
  influence: PopulationInfluence,
  allInfluences: PopulationInfluence[],
  intent: ProblemIntent,
): string[] {
  return graphImpactBadgesForInfluence(influence, allInfluences, intent).map((badge) => `Ref: ${badge.label}`);
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
  for (const source of packet.columnLineage.sourceLeaves) {
    entries.set(source.nodeId, uniqueLabels([...(entries.get(source.nodeId) ?? []), 'Data']));
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
      return ['row_multiplication'];
    case 'outer_join':
      return ['null_extension'];
    case 'group_by':
      return ['grain_change'];
    case 'limit':
      return ['output_cap'];
    case 'order_by':
      return ['output_selection'];
    case 'distinct':
    case 'distinct_on':
      return ['row_deduplication'];
  }
}

function graphFocusBadgesForEffects(
  effects: PopulationEffect[],
  intent: ProblemIntent,
  signals: PopulationSignal[],
  hasTopN: boolean,
): GraphFocusBadge[] {
  return uniqueGraphPopulationSignals(
    problemIntentBadgesForEffects(effects, intent, signals)
      .flatMap((badge) => graphSignalsForPopulationBadge(badge, hasTopN)),
  ).map((signal): GraphFocusBadge => {
    const strength: ProblemIntentMatchStrength = intent === 'all_signals' || graphSignalMatchesIntent(signal, effects, intent) ? 'matched' : 'related';
    return {
      label: graphPopulationSignalLabel(signal),
      signal,
      strength,
    };
  }).filter((badge) => badge.strength === 'matched');
}

function graphSignalsForPopulationBadge(badge: ProblemIntentBadge, hasTopN: boolean): GraphPopulationSignal[] {
  if (badge.signal === 'order_by') {
    return hasTopN ? ['top_n'] : [];
  }
  if (badge.signal === 'limit') {
    return hasTopN ? ['top_n'] : ['limit'];
  }
  return [badge.signal];
}

function graphSignalMatchesIntent(signal: GraphPopulationSignal, effects: PopulationEffect[], intent: ProblemIntent): boolean {
  if (signal === 'top_n') {
    return effects.some((effect) => (effect === 'output_cap' || effect === 'output_selection') && populationEffectMatchesIntent(effect, intent));
  }
  return populationSignalMatchesIntent(signal, effects, intent);
}

function influenceScopeHasTopN(influences: PopulationInfluence[], scopeId: string): boolean {
  const scopeInfluences = influences.filter((influence) => influence.scopeId === scopeId);
  return scopeInfluences.some((influence) => influence.signals.includes('order_by') || influence.kind === 'order_by')
    && scopeInfluences.some((influence) => influence.signals.includes('limit') || influence.kind === 'limit' || influence.kind === 'offset');
}

function nodeImpactHasTopN(signals: PopulationSignal[]): boolean {
  return signals.includes('order_by') && signals.includes('limit');
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
      case 'row_deduplication':
        signals.push('distinct');
        break;
    }
  }
  return uniquePopulationSignals(signals);
}

function uniquePopulationSignals(signals: PopulationSignal[]): PopulationSignal[] {
  const unique = new Set(signals);
  return populationSignalOrder.filter((signal) => unique.has(signal));
}

function uniqueGraphPopulationSignals(signals: GraphPopulationSignal[]): GraphPopulationSignal[] {
  const unique = new Set(signals);
  return ['where', 'having', 'join_xn', 'outer_join', 'distinct', 'distinct_on', 'group_by', 'limit', 'top_n']
    .filter((signal): signal is GraphPopulationSignal => unique.has(signal as GraphPopulationSignal));
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels)];
}
