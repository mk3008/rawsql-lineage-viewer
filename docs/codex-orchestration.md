# Codex Task Orchestration

## Minimal Orchestration Authority

For delegation, recovery, stale handling, or durable progress, use the globally
installed `$minimal-orchestration` skill. It is authoritative for Root, Worker,
and Runtime Adjudicator roles, state transitions, task packets, recovery, and
generated progress views. Store its run ledger at
`tmp/orchestration/<run-id>/ledger.json`, render it after every state
transition, and keep worker reports as evidence rather than a second task-state
authority. Do not hand-edit generated progress files.

The remaining sections provide lineage-specific intake, worker-contract, and
verification guidance. If they conflict with `$minimal-orchestration`, the skill
takes precedence.

Use this guide when a request needs impact analysis and an isolated Codex implementation task. It is a delivery workflow, not a replacement for repository design guidance.

## Control Task Responsibilities

The control task owns intake, impact assessment, task sizing, model selection when authorized, worker handoff, evidence review, and the final status report. It does not make speculative implementation changes while the scope is still unclear.

For lineage behavior, read `docs/lineage-maintenance-map.md` first and name the owning slice before opening a hotspot file. Investigate the smallest relevant slice and connected tests before widening the search.

## Task Intake Record

Create this record in the control task before delegating implementation.

```text
Requested outcome:
Customer value:
Owning slice:
Likely affected files:
Directly connected tests:
Scope in:
Scope out:
Risks:
Acceptance criteria:
Verification plan:
Stop condition:
```

Acceptance criteria must be observable. If they cannot be stated without guessing product intent, stop and request clarification.

## Sizing And Model Policy

| Task size | Use when | Preferred worker |
| --- | --- | --- |
| Small | The change is local and the expected behavior plus tests are clear. | `gpt-5.6-luna`, medium/high reasoning |
| Medium | The change crosses a bounded set of source, test, or UI files. | `gpt-5.6-terra`, high reasoning |
| Large | The change crosses lineage slices, involves uncertain root cause, or needs architecture decisions. | `gpt-5.6-sol`, xhigh reasoning |
| Critical | The task affects release, data integrity, security, or protected deployment. | `gpt-5.6-sol`, max reasoning, plus an independent review pass |

Select a model only when the requester has authorized model selection; otherwise use the configured default model.

## Isolation Policy

Start each unrelated task from `origin/main`, on a new feature branch using the `codex/` prefix. Do not reuse an existing feature branch unless the requester explicitly asks to continue it.

Prefer a Codex project worktree when the repository is registered as its own project. If it is not registered, use a projectless task with a fresh clone of `https://github.com/mk3008/rawsql-lineage-viewer.git` at `main`. Do not create a worktree from the parent workspace repository because this repository is nested inside it.

## Worker Prompt Contract

The initial prompt for an implementation task must include:

```text
Outcome:
Owning slice and why:
Impact risks:
Allowed inspection starting points:
Scope in / scope out:
Observable acceptance criteria:
Required verification commands:
Branch baseline and branch name:
Handoff manifest and durable report path:
Do not push, create a PR, merge, or deploy unless explicitly asked.
Stop and report if requirements become ambiguous or the change crosses an unapproved slice.
```

## Durable Parent-Worker Handoff

Use `$async-orchestration-dispatch`, `$orchestration-knowledge-handoff`, and `$rawsql-lineage-orchestrator` together. The manifest and durable worker report are authoritative. Parent-worker chat is limited to a completion notification and, when necessary, one clear correction request.

### Record Location

Before dispatch, inspect the repository for an existing authoritative task ledger, report store, or knowledge artifact. Use it when it fits the task. Do not invent a default directory, filename, or knowledge store.

The parent must name an existing or explicitly approved durable report destination in the manifest before starting a worker. If it cannot do so, stop before dispatch and request that decision. A worker report is not valid when it exists only in thread history.

### Parent Manifest

After the impact assessment and before creating the child task, provide this compact manifest. The parent owns it and passes it with the worker brief.

```yaml
task_id: <stable-kebab-case-id>
attempt: 1
base_state:
  ref: <for-example-origin/main-or-feature-branch>
  commit: <commit>
  worktree: <path-or-task-environment>
  dirty: <true-or-false>
parent_thread_id: <id-or-null>
durable_report_path: <existing-or-approved-path>
read_before_work:
  - AGENTS.md
  - docs/codex-orchestration.md
  - <owning-slice-guidance-or-connected-test>
purpose: <requested outcome and customer value>
owning_slice: <one-slice-or-approved-cross-slice-scope>
risks: []
non_goals: []
acceptance: []
verification: []
stop_conditions: []
```

For a lineage task, `owning_slice` must be chosen from the maintenance map before dispatch. A request crossing slices needs explicit approved scope; otherwise stop. Select the worker model only when starting this new child task, using the existing sizing policy. Do not change a child model by altering the parent conversation mid-task.

### Worker Report And Notification

The worker must save a durable report first, then notify the parent. Use `ready_for_review`, `blocked`, or `not_done` as the worker terminal status; only the parent may mark the work accepted. Worker status is transport vocabulary: parents and automation must not copy it verbatim into a final report (`worker not_done` becomes final attainment `not done`).

```yaml
report_version: 1
task_id: <same-as-manifest>
attempt: <current-attempt>
worker_thread_id: <id>
parent_thread_id: <id-or-null>
status: ready_for_review | blocked | not_done
base_state: <copied-from-manifest-or-detected-drift>
changed_paths: []
purpose: <copied-from-manifest>
owning_slice: <copied-from-manifest>
risks: []
non_goals: []
acceptance:
  - criterion: <original-observable-criterion>
    status: done | partial | not_done
    evidence: <command-test-file-or-inspection>
verification: []
human_or_external_evidence:
  - item: <deployment-service-or-human-UI-check>
    status: UNCONFIRMED | confirmed
    reason: <why-it-is-or-is-not-proven>
stop_condition: null
knowledge_candidates:
  durable_decisions: []
  operational_rules: []
  task_evidence: []
  transient_notes: []
recommended_next: parent_review | correction | human_decision
```

Send this message only after the report is saved:

```text
[WORKER_REPORT v1] task_id=<id> attempt=<n> status=<status>
report=<durable-path> worker_thread_id=<id> next=<action>
```

### Transport Handshake And Fallback

Thread delivery is a notification channel, not the authoritative work record.
The parent obtains the actual child thread id from the Codex thread registry
immediately after creation, records it in the manifest, and sends a bootstrap
message containing both the child and parent ids. A worker must copy those
ids; it must not substitute a runtime label such as `/root`, reuse another
worker's id, or guess an id from its prompt.

The bootstrap message requests a short acknowledgement using the supplied
ids. If that acknowledgement or the terminal notification is absent, the
parent must inspect the child thread and the named durable report directly.
The parent treats a report with an id mismatch as `not accepted`, sends a
same-thread correction with the authoritative ids and an incremented attempt,
and verifies the repaired notification before accepting the work.

This fallback prevents a missed notification from being mistaken for lost
work, while preserving the rule that report contents—not chat delivery—are
the source of truth. Do not poll workers indefinitely: inspect only after the
agreed completion window, a missed acknowledgement, or a reported terminal
state without a valid notification.

### Parent Review And Correction

Before accepting a worker report, the parent verifies the `task_id`, `attempt`, worker source, `base_state`, report path, changed paths, and acceptance evidence. Review only the changed files and the smallest checks that prove the original criteria. Keep repository evidence separate from human-only or external evidence.

The parent alone decides whether to promote a knowledge candidate into an existing durable guidance artifact. Workers must not silently change long-lived guidance outside the task scope.

When a concrete acceptance gap remains, send one correction brief to the same worker thread. Keep the same `task_id`, increment `attempt`, preserve the non-goals, name the observed evidence and exact missing proof, and require a new durable report before another notification. Do not create a replacement thread for a correction.

### Stop Conditions

Stop and report the evidence, options, and recommended next action when:

- the requested work crosses lineage slices without explicit scope;
- a durable report destination cannot be identified or approved;
- proof depends on an unavailable external service, release/deployment action, or human UI confirmation;
- base-state drift makes the worker report unreliable; or
- acceptance criteria cannot be made observable.

Keep human confirmation and deployment evidence as `UNCONFIRMED` until it is actually available; do not infer it from a successful local check.

For GitHub Pages work, the worker must preserve the protected route: feature branch, pull request into `main`, merge, then `Deploy GitHub Pages` from `main`.

## Completion Gate

The control task may report `done` only after it has reviewed:

1. targeted tests and relevant build/type checks;
2. changed documentation or configuration consistency;
3. two self-review cycles: coverage/evidence gaps, then blocker triage;
4. any required external evidence, clearly marked `UNCONFIRMED` when unavailable.

Final reports must separate repository evidence from supplementary evidence and use one attainment status: `done`, `partial`, or `not done`.
