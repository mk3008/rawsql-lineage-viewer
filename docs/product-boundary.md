# Product Boundary Contract

Status: **Normative**

This document defines the product responsibility boundary for rawsql-lineage.
It applies across the Core, Viewer, CLI, and MCP surfaces. It does not define a
versioned artifact schema, safety-label vocabulary, parameter-binding protocol,
or probe-interpretation policy; separate versioned contracts may refine
behavior without expanding this boundary implicitly.

The terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Product definition

rawsql-lineage is a deterministic static investigation compiler. It transforms
only caller-supplied SQL, optional DDL or `SchemaFacts`, and explicit configuration
into investigation artifacts. For the same supported inputs,
configuration, and product version, compilation MUST be reproducible without
consulting ambient runtime state or an external service.

The product helps a user understand, audit, and plan an investigation. It does
not perform the external investigation or decide its outcome.

## Compilation boundary

### Inputs

Depending on the operation, the compiler MAY accept:

- SQL text supplied directly or through an explicitly selected local file;
- DDL or `SchemaFacts` supplied by the caller;
- an explicit diagnostic target, symptom, or other supported configuration;
- explicit parameter metadata or values supplied through the current
  interface.

The compiler MUST treat these inputs as assertions from the caller. DDL and
`SchemaFacts` describe the supplied model; they are not proof of a live schema.
The product MUST NOT discover or expose secret values or runtime bindings from
an application, database, credential store, or environment.

### Deterministic transformation

Within the boundary, Core MAY parse supported SQL and DDL, build lineage and
schema facts, identify static diagnostic candidates, and compile investigation
artifacts. The transformation MUST use only the supplied inputs, explicit
configuration, and versioned product logic. It MUST NOT depend on database
contents, query results, network responses, or LLM inference.

### Outputs

Investigation artifacts MAY include lineage models, diagnostics, candidate
concerns, warnings, investigation plans, parameter requirements, proposed
probe SQL, blocked reasons, and explanatory metadata supported by the current
interfaces. This list describes the responsibility boundary, not a frozen
artifact taxonomy or schema.

Artifacts are static evidence and planning material. They MAY support an
external investigation by showing derivation, assumptions, uncertainty, and
candidate checks. They MUST NOT be represented as observed database facts,
executed results, root-cause verdicts, or proof that a proposed statement is
correct for a live system.

If an artifact contains SQL, that SQL is compiler output only. Its presence
does not mean that the product executed it, validated it against a database,
proved it free of dialect-specific effects, or established it as a corrected
query.

## Surface responsibilities

| Surface | Owns | Does not own |
| --- | --- | --- |
| Core | Deterministic static compilation and the semantic content of emitted artifacts | Database access, runtime observation, root-cause decisions, or remediation |
| Viewer | Rendering, tracing, auditing, and explaining supplied or locally compiled artifacts | Independently changing artifact meaning, deciding root cause, or claiming investigation completion |
| CLI | Explicit local input/output transport for Core operations | Additional diagnostic semantics, database execution, or hidden runtime binding |
| MCP | Structured tool transport for Core operations and results | LLM inference, autonomous investigation, database execution, or semantic divergence from Core |

The Viewer MAY compile inputs locally through Core, but its product role remains
an audit and explanation surface. CLI and MCP adapters MUST preserve Core
semantics. A host using MCP may reason about returned artifacts, but that host
reasoning is external to this product boundary.

## Explicit exclusions

The product boundary excludes all of the following:

- opening a database connection or executing product SQL;
- reading live schema, data, permissions, plans, logs, or query results;
- making a network request as part of compilation;
- using LLM inference to create or validate an artifact;
- discovering, retrieving, or exposing secrets and runtime parameter bindings;
- issuing a root-cause verdict;
- generating or endorsing a corrected query as semantically equivalent;
- proving production safety, correctness, or database-specific side-effect
  absence;
- completing an end-to-end debugging or remediation workflow.

These exclusions apply even when a transport host, browser, shell, or external
agent has those capabilities.

## Assurance and confidence

The product MAY provide confidence, warnings, or static classifications when
their basis is present in the supplied inputs and versioned compiler logic.
Such language MUST identify static evidence and uncertainty accurately. A
successful compilation can establish that an artifact was derived
deterministically under the supported parser and product rules. It cannot, by
itself, establish:

- that supplied DDL matches production;
- that data exhibits the reported symptom;
- that permissions or runtime bindings are available;
- that a probe behaves as expected in a particular SQL dialect or database;
- that a candidate concern is the root cause; or
- that a modification preserves semantics.

Static labels and checks are decision support, not execution authorization.
Unknown, unsupported, or insufficiently evidenced cases SHOULD remain explicit
rather than being converted into a confident conclusion.

## External investigation handoff

Responsibility leaves the product boundary when a person or authorized system
uses an artifact to inspect a real environment. That external investigator is
responsible for authorization, secret and runtime binding, database
connectivity, execution controls, dialect review, result capture, comparison
with an accepted baseline, root-cause conclusions, and any remediation.

The handoff SHOULD preserve the compiler version, supplied inputs, relevant
artifact, assumptions, warnings, unresolved parameters, and blocked reasons so
that an external result can be traced back to the static evidence. Runtime
observations and human conclusions MUST remain distinguishable from artifacts
emitted by Core.

## Change control

Artifact kinds, safety labels, binding contracts, and interpretation rules MAY
be defined by separate versioned contracts. They MUST remain within this
boundary unless a deliberate product-boundary change is reviewed and published.
