import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceptedHarnessCases } from './cases/acceptedCases';
import { DisposablePostgres, type CleanupEvidence, type RuntimeMetadata } from './disposablePostgres';
import { runHarnessCase, type ScenarioEvidence } from './harness';

const evidencePath = resolve(
  process.cwd(),
  'tmp/orchestration/fixture-extraction-select-poc/evidence/external-harness-attempt-1.json',
);

interface RunEvidence {
  authoritativeHashes: {
    acceptedGeneratorReportSha256: string;
    scenarioOracleSha256: string;
  };
  cleanup: CleanupEvidence | null;
  completedAt: string | null;
  error: { class: string; message: string } | null;
  executionPolicy: {
    captureSqlSource: 'ready bounded generator steps only';
    originalDmlExecuted: false;
    parameterValueInterpolation: false;
    rowTransfer: 'test-only parameterized INSERT';
    syntheticLocalOnly: true;
  };
  runtime: RuntimeMetadata | null;
  scenarios: ScenarioEvidence[];
  startedAt: string;
  status: 'failed' | 'passed';
}

async function main(): Promise<void> {
  const evidence: RunEvidence = {
    authoritativeHashes: {
      acceptedGeneratorReportSha256: '149B6EF97B1CACC59111DF3F82C83BC23BADF4ED05AEFDDD61A0979E951C3243',
      scenarioOracleSha256: '2E2C05A44F3B9A332145AF6C111A1001DFC8FA6472AC44042F6215DAFBD4AFFD',
    },
    cleanup: null,
    completedAt: null,
    error: null,
    executionPolicy: {
      captureSqlSource: 'ready bounded generator steps only',
      originalDmlExecuted: false,
      parameterValueInterpolation: false,
      rowTransfer: 'test-only parameterized INSERT',
      syntheticLocalOnly: true,
    },
    runtime: null,
    scenarios: [],
    startedAt: new Date().toISOString(),
    status: 'failed',
  };

  let postgres: DisposablePostgres | undefined;
  try {
    postgres = await DisposablePostgres.start();
    evidence.runtime = postgres.metadata;
    for (const scenario of acceptedHarnessCases) {
      const result = await runHarnessCase(postgres.source, postgres.target, scenario);
      evidence.scenarios.push(result);
      if (result.mismatchClassification === 'mismatch') throw new Error(`${scenario.id}: source and target original-query results differ.`);
    }
    evidence.status = 'passed';
  } catch (error) {
    evidence.error = {
      class: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : 'Unknown harness error',
    };
    process.exitCode = 1;
  } finally {
    if (postgres) {
      try {
        evidence.cleanup = await postgres.cleanup();
      } catch (error) {
        evidence.error ??= {
          class: error instanceof Error ? error.name : typeof error,
          message: 'Harness cleanup verification failed.',
        };
        evidence.status = 'failed';
        process.exitCode = 1;
      }
    }
    if (!evidence.cleanup
      || !evidence.cleanup.containerRemoveSucceeded
      || !evidence.cleanup.loopbackPortClosed
      || evidence.cleanup.remainingNamedContainers.length > 0) {
      evidence.status = 'failed';
      process.exitCode = 1;
    }
    evidence.completedAt = new Date().toISOString();
    mkdirSync(resolve(evidencePath, '..'), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ evidencePath, scenarioCount: evidence.scenarios.length, status: evidence.status })}\n`);
  }
}

void main();
