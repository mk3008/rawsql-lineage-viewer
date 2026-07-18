import { AlertTriangle, CheckCircle2, ClipboardList, Info } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { InvestigationPlanV1 } from '../lineage/investigationPlan';
import {
  createInvestigationPlanForTarget,
  discoverInvestigationTargets,
  type InvestigationDiscoveredTargetV1,
  type InvestigationTargetDiscoveryV1,
} from '../lineage/investigationTargetDiscovery';

export function InvestigationAuditViewer({ sql }: { sql: string }) {
  const discovery = useMemo(() => discoverInvestigationTargets({ sql }), [sql]);
  const selectableTargets = discovery.targets.filter(isSelectableTarget);
  const [targetId, setTargetId] = useState(selectableTargets[0]?.id ?? '');
  const [plan, setPlan] = useState<InvestigationPlanV1 | null>(null);

  useEffect(() => {
    setTargetId(selectableTargets[0]?.id ?? '');
    setPlan(null);
  }, [sql]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTarget = discovery.targets.find((target) => target.id === targetId);
  const blockerCount = discovery.analysis.ambiguousTargetCount + discovery.analysis.unsupportedTargetCount;

  return (
    <section className="investigation-audit" aria-labelledby="investigation-audit-title">
      <header className="investigation-audit-header">
        <div>
          <span className="investigation-audit-eyebrow">Static artifact review</span>
          <h2 id="investigation-audit-title">Investigation audit</h2>
        </div>
        <span className="investigation-audit-status">
          <Info size={14} aria-hidden="true" /> Not executed
        </span>
      </header>

      <dl className="investigation-audit-provenance" aria-label="Artifact provenance">
        <div><dt>Artifact</dt><dd>Investigation plan v1</dd></div>
        <div><dt>Source</dt><dd>Submitted SQL</dd></div>
        <div><dt>Analysis</dt><dd>Original, parser {discovery.analysis.parserVersion}</dd></div>
      </dl>

      {selectableTargets.length > 0 ? (
        <div className="investigation-audit-task">
          <label htmlFor="investigation-target">Target</label>
          <select id="investigation-target" value={targetId} onChange={(event) => {
            setTargetId(event.target.value);
            setPlan(null);
          }}>
            {selectableTargets.map((target) => (
              <option key={target.id} value={target.id}>{target.identity.node.label} · {target.identity.column.name}</option>
            ))}
          </select>
          <button
            className="primary-button investigation-audit-primary"
            type="button"
            disabled={!targetId}
            onClick={() => setPlan(createInvestigationPlanForTarget({ sql }, targetId))}
          >
            <ClipboardList size={15} aria-hidden="true" /> Review plan
          </button>
        </div>
      ) : (
        <AuditBlocker discovery={discovery} />
      )}

      {blockerCount > 0 && selectableTargets.length > 0 ? (
        <p className="investigation-audit-inline-warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" /> {blockerCount} other {blockerCount === 1 ? 'target needs' : 'targets need'} clarification or more schema facts.
        </p>
      ) : null}

      {plan && selectedTarget ? <PlanAudit plan={plan} target={selectedTarget} /> : null}
    </section>
  );
}

function PlanAudit({ plan, target }: { plan: InvestigationPlanV1; target: InvestigationDiscoveredTargetV1 }) {
  const prerequisites = plan.probePrerequisiteFacts;
  const assumptions = prerequisites?.observations.flatMap((item) => item.assumptions) ?? [];
  const blockedObservations = prerequisites?.observations.filter((item) => item.status === 'blocked') ?? [];
  const limitations = [...plan.limitations.map((item) => item.message), ...plan.candidateConcerns.flatMap((item) => item.limitations)];

  return (
    <div className="investigation-audit-result" aria-live="polite">
      <div className="investigation-audit-result-heading">
        <CheckCircle2 size={18} aria-hidden="true" />
        <div><strong>{target.identity.node.label} · {target.identity.column.name}</strong><span>Static review ready</span></div>
      </div>

      <div className="investigation-audit-grid">
        <AuditSection title="Facts">
          <ul>
            <li>{prerequisites?.sources.length ?? 0} source facts</li>
            <li>{prerequisites?.aggregates.length ?? 0} aggregate facts</li>
            <li>{prerequisites?.groupingKeys.length ?? 0} grouping-key facts</li>
            <li>Target provenance: {prerequisites?.target.status ?? 'unsupported'}</li>
          </ul>
        </AuditSection>
        <AuditSection title="Safety">
          <ul>
            <li>Static parser and lineage artifacts only</li>
            <li>No database connection or SQL execution</li>
            <li>No observations or root-cause proof</li>
          </ul>
        </AuditSection>
        <AuditSection title="Assumptions">
          <AuditList items={unique(assumptions)} empty="No observation assumptions reported." />
        </AuditSection>
        <AuditSection title="Limitations">
          <AuditList items={unique(limitations)} empty="No additional limitations reported." />
        </AuditSection>
      </div>

      {(plan.blockedProbes.length > 0 || blockedObservations.length > 0 || (prerequisites?.issues.length ?? 0) > 0) ? (
        <div className="investigation-audit-blockers" role="status">
          <h3><AlertTriangle size={16} aria-hidden="true" /> Blockers</h3>
          <ul>
            {plan.blockedProbes.map((item) => <li key={item.id}>{item.reason}</li>)}
            {prerequisites?.issues.map((item) => <li key={`${item.code}:${item.factIds.join(',')}`}>{item.message}</li>)}
            {blockedObservations.map((item) => <li key={item.id}>Observation prerequisite blocked: {item.kind.replaceAll('_', ' ')}</li>)}
          </ul>
        </div>
      ) : null}

      <AuditSection title="Next evidence">
        {plan.nextEvidenceChecklist.length > 0 ? (
          <ol className="investigation-audit-next">
            {plan.nextEvidenceChecklist.map((item) => <li key={item.id}>{describeNextEvidence(item)}</li>)}
          </ol>
        ) : <p className="investigation-audit-empty">No static next-evidence item is available.</p>}
        <p className="investigation-audit-boundary">These are items to verify externally. They are not executed evidence or a diagnosis.</p>
      </AuditSection>
    </div>
  );
}

function AuditBlocker({ discovery }: { discovery: InvestigationTargetDiscoveryV1 }) {
  const messages = unique([...discovery.ambiguities.map((item) => item.message), ...discovery.unsupported.map((item) => item.message)]);
  return (
    <div className="investigation-audit-empty-state" role="alert">
      <AlertTriangle size={20} aria-hidden="true" />
      <div>
        <strong>No reviewable target</strong>
        {messages.length > 0
          ? <ul>{messages.map((message) => <li key={message}>{message}</li>)}</ul>
          : <p>The submitted SQL has no output target that can be identified statically.</p>}
        <span>Clarify duplicate outputs or provide schema facts, then analyze the SQL again.</span>
      </div>
    </div>
  );
}

function AuditSection({ children, title }: { children: ReactNode; title: string }) {
  return <section className="investigation-audit-section"><h3>{title}</h3>{children}</section>;
}

function AuditList({ empty, items }: { empty: string; items: string[] }) {
  return items.length > 0 ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="investigation-audit-empty">{empty}</p>;
}

function isSelectableTarget(target: InvestigationDiscoveredTargetV1): boolean {
  return target.selection.status === 'selectable';
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function describeNextEvidence(item: InvestigationPlanV1['nextEvidenceChecklist'][number]): string {
  if (item.kind === 'relation') return `Verify ${item.relation.relationName} columns: ${item.relation.columnNames.join(', ') || 'record shape'}.`;
  if (item.kind === 'condition') return `Verify ${item.condition.kind.replaceAll('_', ' ')} in scope ${item.condition.scopeId}.`;
  return `Verify the ${item.property.kind.replaceAll('_', ' ')} property.`;
}
