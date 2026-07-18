# Static Investigation Compiler Program Report

## Accepted result

- Accepted local program commit: `f74c8c7d70fea1576c63b5ea75015ce94f8d6b39`
- Integration base: `origin/main` at `33305a3dfc74a084a91a2f91a31c89d9eb21a6e3`
- Final-review remediation base: PR head `1ab7c40fb9692f4442760a6def238e19de6dfebc`
- Relationship: the integration base is an ancestor of the accepted result; no rebase was required.
- Scope: a practical baseline for a static SQL investigation compiler through both CLI and MCP.

The final verification task introduced no product-code changes. The verified
program result remained fixed at the accepted commit before this durable report
and evidence cleanup were added for pull-request review.

## Product boundary

The shipped Core, CLI, and MCP:

- parse only submitted SQL and explicitly supplied DDL or schema facts;
- do not connect to a database or execute submitted SQL;
- do not retrieve runtime data, credentials, or binding values;
- do not make network or LLM calls;
- produce deterministic static plans, safe blocked results, and versioned errors;
- do not assert an automatic root cause or generate a corrected query.

Runtime probe execution remains external to the shipped product. The isolated
Utility Benchmark used synthetic fixtures in an ephemeral PostgreSQL container.

## Implemented contracts

The program completed the following dependency-ordered capabilities:

1. Product boundary and SQL artifact classification.
2. Syntactic safety evidence with runtime properties left explicitly unverified.
3. Parameter-definition and binding separation with binding-value non-disclosure.
4. Deterministic next-evidence and probe-interpretation contracts.
5. Target discovery with selectable, ambiguous, unsupported, and fail-closed outcomes.
6. Target-bound, provenance-closed prerequisite facts.
7. A documented utility ceiling that blocks heuristic aggregate/grain probe generation.
8. Compiled public, CLI, and MCP entrypoints with a common V1 error envelope.
9. A strict package-content allowlist.
10. A Viewer audit flow for ready and ambiguous investigation states.

## Utility Benchmark

The external benchmark used `postgres:16-alpine`, loopback-only connectivity,
synthetic public fixtures, private temporary bindings, read-only probe
transactions, statement and lock timeouts, and a 100-row cap. Teardown evidence
confirmed container, volume, loopback port, temporary credential, and temporary
directory removal.

The accepted investigation probe executed successfully in both the SQL-defect
and data-anomaly scenarios, with zero unsafe probes, overclaims, or parameter
leakage. Each observation matched its private observation contract, but the
faulty and control results did not differ. Consequently, the benchmark reports
zero faulty/control discrimination and marks the root mechanism inconclusive.
Observation-contract agreement is not reported as defect discrimination. This
evidence establishes the current utility ceiling rather than universal probe
usefulness.

Attempt 23 replaced regex parameter substitution with tokenizer-derived,
source-position-aware rewriting. It skips SQL lexical regions and PostgreSQL
casts, reuses positional parameters, permits declared-but-unused definitions,
and rejects unknown, duplicate, or unsupported parameter tokens. The executor
submits only used bindings, preserves the original execution error if rollback
also fails, and records planner, executor-entry, and submitted-statement hashes
separately.

Attempt 23 was executed twice. The durable outputs were identical except for the
explicit `elapsedMs` observation. After removing that volatile timing field,
both evidence documents had normalized SHA-256
`b3fe58208f50d10ef6b142c9c7311fd3e74bedb6c6d08eb8e4d1cf3e4bdc6270`.
The two raw hashes, normalization procedure, and equality result are preserved
in the [final-review remediation evidence](../../tmp/orchestration/utility-benchmark-v1/final-review-remediation-evidence.yaml).

The subsequent feasibility decision therefore generated no new aggregate/grain
probe SQL. Missing provenance-closed SQL artifacts, authorized binding
manifests, and scenario/oracle mappings remain automatic safe blockers.

Repository evidence:

- [Utility Benchmark runner](../../tests/dogfooding/utility-benchmark-v1/run.ts)
- [Utility Benchmark safety contract](../../tests/dogfooding/utility-benchmark-v1/safety.ts)
- [Final benchmark evidence](../../tmp/orchestration/utility-benchmark-v1/evidence-attempt-23.json)
- [Final benchmark report](../../tmp/orchestration/utility-benchmark-v1/report-attempt-23.yaml)
- [Probe feasibility decision](../probe-feasibility-decision-v1.md)

## CLI, MCP, and package validation

The compiled package was installed offline into an isolated consumer project.
Validation covered:

- the public runtime import;
- TypeScript consumption of `InvestigationPlanV1` and
  `ProbePrerequisiteFactsV1`;
- compiled CLI invocation;
- compiled MCP startup;
- deterministic V1 errors for unsupported versions, missing paths or inputs,
  and invalid workspaces;
- a strict 25-file package allowlist with an exact generated-chunk contract and
  no source, test, Viewer asset, or orchestration leakage.

The CLI and MCP share the static planning contract. Parameter scalar values are
validated only at caller boundaries and reduced to deterministic binding
presence names; values are not serialized into plans or errors.

Repository evidence:

- [Package smoke](../../scripts/package-smoke.mjs)
- [Package manifest](../../package.json)
- [CLI entrypoint](../../bin/rawsql-lineage.mjs)
- [MCP entrypoint](../../bin/rawsql-lineage-mcp.mjs)
- [Public exports](../../src/public.ts)

## Viewer validation

Chromium E2E covered:

- a ready target reviewed by keyboard activation; and
- ambiguous duplicate outputs with no review action and visible recovery text.

The Viewer exposes target identity, static provenance, facts, safety,
assumptions, limitations, blockers, and next evidence. It contains no database
or probe execution affordance and does not present static output as a diagnosis
or root-cause proof.

Screenshots are generated by the test and are intentionally not committed.

Repository evidence:

- [Viewer audit component](../../src/components/InvestigationAuditViewer.tsx)
- [Viewer Chromium E2E](../../tests/e2e/investigation-audit.spec.ts)
- [Lineage Chromium E2E](../../tests/e2e/lineage.spec.ts)
- [Final-review remediation evidence](../../tmp/orchestration/utility-benchmark-v1/final-review-remediation-evidence.yaml)

## Verification summary

- Integrated Vitest suite with Docker-backed synthetic scenarios available: 317 passed, 4 skipped.
- TypeScript typecheck: passed.
- Viewer and package build: passed.
- Offline package smoke and allowlist: passed.
- Compiled public, CLI, MCP, and V1 error probes: passed.
- Viewer Chromium E2E: 69 passed. The 38 lineage-suite failures reproduced on
  the integration base were stale Viewer expectations; the final suite has no skipped E2E tests.
  The compared commits, commands, counts, and durations are recorded in the
  [final-review remediation evidence](../../tmp/orchestration/utility-benchmark-v1/final-review-remediation-evidence.yaml).
- Leakage and security scans: passed.
- `git diff --check`: passed.

The DB-backed scenario suite is intentionally excluded from the normal DB-free
suite. It uses Docker and PostgreSQL to compare faulty and corrected scenario
results and does not define shipped Core, CLI, or MCP behavior. Isolated
synthetic database execution is covered separately by the Utility Benchmark.

## Skipped tests

The four skipped tests are host-dependent symlink-security cases in
`src/mcp/investigationServer.pathSecurity.test.ts`:

1. Reject external SQL, DDL, schema-fact, and DDL-directory symlink targets.
2. Reject nested file, directory, and chained external symlink targets.
3. Allow internal symlinks while deduplicating DDL by canonical path.
4. Reject aliases into canonical excluded directories.

Reason: the Windows verification host could not create test symlinks without
additional operating-system privilege. These are host-dependent skips, not
product limitations. Non-symlink traversal, absolute-path, missing-path,
exclusion, extension, depth, count, and size-limit tests passed. Release impact
is non-blocking; symlink-capable CI should execute these four cases.

## Security and leakage result

Final scans reported:

- zero DB-client imports or database connections in shipped Core, CLI, and MCP;
- zero submitted-SQL execution in shipped components;
- zero product network, LLM, unsafe dynamic execution, or child-process calls;
- zero binding-value, credential, or secret output;
- zero newly generated aggregate/grain probes after the feasibility decision;
- zero unexpected package paths or Viewer assets;
- zero push, merge, publish, release, or deployment during local acceptance.

## Known limitations

- Probe coverage is intentionally incomplete.
- Current benchmark probes can execute safely yet remain inconclusive.
- Root cause remains a human or external-investigator decision.
- Production database behavior was not validated.
- Corrected-query generation is not implemented.
- Unattended nested MCP approval is outside the product contract.
- Full assistive-technology runtime and numeric contrast measurements remain
  release-level checks.
- Consumers must follow the documented V1 compatibility boundary.

## Explicit non-claims

This program does not claim:

- universal SQL defect coverage;
- automatic root-cause determination;
- universal JOIN, aggregate, or EXISTS probe coverage;
- production database validation;
- database connectivity in Core, CLI, or MCP;
- corrected-query generation;
- generalized runtime utility;
- complete assistive-technology conformance.

## Evidence hashes

SHA-256 hashes for the final-review remediation evidence:

| Repository path | SHA-256 |
| --- | --- |
| `tmp/orchestration/utility-benchmark-v1/evidence-attempt-23.json` | `525F8C1714AC2561CEC69225CBFDF1F9ECBDE17AD86ADDF6386E5CB97FC4E766` |
| `tmp/orchestration/utility-benchmark-v1/report-attempt-23.yaml` | `481D0DF9D38054C3CF1A1C9974620F8E7FBEF8319D949160CA961B5585A65FD0` |
| `tmp/orchestration/utility-benchmark-v1/final-review-remediation-evidence.yaml` | `4A55DBAEB172F1C18833F72F4A54097E688F203C5F79ABB40495B66885DE8EFE` |
| `scripts/package-smoke.mjs` | `21781E1A74F14F1FA2CE6125E46CDD96B7109BBAAAFFB2DF208D3D075E68D8C9` |
| `tests/e2e/lineage.spec.ts` | `79DB1125B6A7887ED71478ABA7DFEF3A92071C411DC4CFEFE1A0808FF9367BCC` |
| `tests/e2e/investigation-audit.spec.ts` | `4D3BF3F29424A1E2F8DAD505BD550FD126B5BC8827C5AB227E1E97E649405C2B` |
| `docs/probe-feasibility-decision-v1.md` | `8F3D9290E574C461D45D0C0B29D4C8AF119E575C2F1A9B2F662C05FF0E57F21F` |

Raw AI transcripts, machine-specific paths, private fixture oracles, credentials,
binding values, database dumps, container state, node_modules, package tarballs,
and non-durable screenshots are not part of this report.
