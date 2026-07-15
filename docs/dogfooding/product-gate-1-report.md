# Product Dogfooding Gate 1 Report

Overall result: **meets**
Gate status: **CLOSED**

## Goal and Outcome

Gate 1 evaluated whether the SQL Investigation Planner is usable through CLI and MCP without DB connectivity, SQL execution, semantic SQL edits, invented investigation SQL, or root-cause overclaims. The accepted outcome is that an AI host can use the planner for an actionable scenario and can safely stop for a blocked scenario.

The human accepted **Option 1**: interactive Codex CLI real-host trials are the formal Gate 1 acceptance evidence. The nested/non-interactive CLI limitation is a separate host-approval concern and is non-blocking for this product gate.

## Product Capabilities Confirmed

- CLI and MCP surfaces are available.
- CLI/MCP plan parity: 6/6 exact JSON parity.
- The interactive real-host actionable scenario produced a useful static investigation plan from local SQL/DDL files.
- The interactive real-host blocked scenario stopped safely with a blocked code and reason; it did not invent unavailable investigation SQL.
- Semantic SQL edits: 0.
- New investigation SQL statements authored by the AI: 0.
- Unsafe probes: 0.
- Database writes: 0.
- Root-cause overclaims: 0.
- The MCP and CLI did not connect to a database or execute SQL.
- The Gate used the published `rawsql-ts` version `0.30.1`.

## Baseline and Repository Evidence

- Clean Gate worktree commit: `a95716aa3d764cb47c2ce55bf5d39c29e9a6ec16`.
- `npm ci` passed; 256 packages were restored with no vulnerabilities reported.
- Test suite: 234 passed, 4 skipped.
- Typecheck and build passed; build emitted only the Vite chunk-size warning.
- Product paths `package.json`, `package-lock.json`, and `src` matched the approved PR #15 baseline before Gate evidence work.
- Gate work added no tracked product, dependency, fixture, runtime, or configuration change.

## Accepted Real-host Evidence

The interactive Codex CLI trials are supplementary human-observed evidence and are the accepted real-host boundary for this Gate. Their raw transcripts are intentionally not copied into this tracked report.

- Actionable: `parameterized-where-mismatch`, using local `sqlPath` and `ddlFiles`; `paid_amount`, `value_too_low`, `status=succeeded`, and `customer_id=10` were supplied. The AI selected `create_investigation_plan`, preserved the supplied SQL meaning, treated candidates as unconfirmed, and did not execute SQL.
- Blocked: `missing-correlated-exists`; the AI selected `create_investigation_plan`, reported `UNSUPPORTED_CONCERN_KIND`, generated no unproven SQL, made no root-cause claim, and identified the next human checks.

## Attempt 5 — Non-interactive Host Approval Limitation

Classification: **partial — non-interactive host approval limitation**.

The nested Codex CLI selected only `create_investigation_plan` and attempted the MCP call twice. Both calls ended as `user cancelled MCP tool call` before a tool result was returned. The evaluated host used no shell command, alternate tool, DB connection, SQL execution, or invented SQL.

This is a Codex host approval / non-interactive execution layer limitation. It is **not** evidence of a Viewer Planner defect, MCP server defect, CLI defect, rawsql-ts defect, SQL-safety defect, or tool-selection failure. Its impact on Product Dogfooding Gate 1 is non-blocking.

The untracked local Attempt 5 worker report is preserved as supplementary evidence. Its classification and checksum are recorded in the committed [Gate 1 evidence index](../../tmp/orchestration/product-dogfooding-gate-1/gate1-mcp-real-host-trial-ui/attempt-2/evidence-index.md): SHA-256 `9971ECBECB05FF7E4AF512B8057052361BF39897F9C9F71F89C4DF27AEC10490`.

## Remaining Limitation

Unattended or nested Codex CLI execution of a local MCP tool remains unverified because the host approval path cancelled the calls before tool results were returned. This does not reopen Gate 1.

## Future Candidate (Not Started)

**Unattended MCP Approval / Automation Integration Gate** may later assess non-interactive MCP approval, nested-agent permission delegation, unattended orchestration, trust policy, and the security boundary. No Gate, issue, branch, or PR was created for it.

## Evidence Index

See the committed [Gate 1 evidence index](../../tmp/orchestration/product-dogfooding-gate-1/gate1-mcp-real-host-trial-ui/attempt-2/evidence-index.md). It provides repository-relative artifact identifiers, SHA-256 hashes, classifications, and the raw-evidence boundary without embedding transcripts.

## Review Triage

- Product Gate result: **meets**.
- Attempt 5: **partial** only at the non-interactive host approval layer.
- Product defect indicated: **no**.
- Safety defect indicated: **no**.
- Next automatic action: **none**.
