# Codex orchestration adapter

For work requiring delegation, recovery, stale handling, or durable progress,
use the globally installed `$minimal-orchestration` skill. It is the authority
for Root, Worker, and Runtime Adjudicator roles, state transitions, task
packets, recovery, and generated progress views.

Before dispatch, identify the lineage slice from `docs/lineage-maintenance-map.md`.
Store the run ledger at `tmp/orchestration/<run-id>/ledger.json`; render it
after every state transition. Keep worker reports as evidence, not as an
alternate source of task state. Do not hand-edit generated progress files.
