import { describe, expect, it } from 'vitest';
import { toBindingSafeProbeEvidence, toBindingSafeRequest } from './run';

const opaqueBinding = 'opaque-binding-sentinel';

describe('product gate binding evidence boundary', () => {
  it('records binding names without persisting values in the MCP transcript request', () => {
    const evidence = toBindingSafeRequest({
      arguments: {
        parameterBindings: { customer_id: opaqueBinding },
        parameterDefinitions: [{ name: 'customer_id', origin: 'investigation_key' }],
        sqlPath: 'query.sql',
      },
      name: 'create_investigation_plan',
    }, ['customer_id']);
    const serialized = JSON.stringify(evidence);

    expect(serialized).not.toContain(opaqueBinding);
    expect(serialized).not.toContain('parameterBindings');
    expect(serialized).not.toContain('"value"');
    expect(evidence).toMatchObject({ arguments: { providedBindingNames: ['customer_id'] } });
  });

  it('records probe execution structure without invocation arguments or results', () => {
    const evidence = toBindingSafeProbeEvidence(
      'probe:example',
      'SELECT * FROM orders WHERE customer_id = :customer_id',
      'PREPARE probe AS SELECT * FROM orders WHERE customer_id = $1',
      [{ name: 'customer_id', position: 1 }],
    );
    const serialized = JSON.stringify(evidence);

    expect(serialized).not.toContain(opaqueBinding);
    expect(evidence).not.toHaveProperty('executeWrapper');
    expect(evidence).not.toHaveProperty('fixtureSafeValues');
    expect(evidence).not.toHaveProperty('rowOutput');
    expect(evidence).toMatchObject({ resultPersisted: false });
  });
});
