---
name: verify-implementation
description: Build an evidence-grounded correctness case before changing code, then reconcile the implementation against it. Use when the user says /verify-implementation or Verify Implementation, or asks to validate whether a feature, bug fix, refactor, migration, integration, implementation plan, or existing diff will fulfill their intent. Apply it to preflight a change without editing or running the target program, to gate an implementation on human review, or to audit a proposed or completed change.
---

# Verify Implementation

## Purpose

Create a shared, reviewable argument that a proposed code change will fulfill the user's intent. Reify the request, relevant system facts, correctness obligations, proposed changes, causal links, assumptions, and counterexamples before implementation.

Treat the result as a **correctness case** or **assurance argument**, not a mathematical proof. Never claim that an LLM-generated argument guarantees correctness. Claim only that the stated obligations are covered by the cited evidence and assumptions.

Write the artifact in the user's language. Keep it proportional to the change.

## Operating modes

Select the mode from the request:

- **Preflight:** Inspect and reason, but do not edit the repository or execute the target program. Use this by default when the user asks to plan, verify first, or review correctness.
- **Implement:** Produce the preflight correctness case first. Wait for the user's approval before editing unless the user explicitly authorizes continuing automatically after a PASS verdict.
- **Audit:** Evaluate an existing plan, patch, diff, or implementation against reconstructed intent and obligations. Do not modify it unless the user also asks for a fix.

Read-only repository inspection is allowed in every mode. Static inspection tools may be used, but the correctness case must not depend on running the application or tests. If evidence from compilation, tests, or runtime behavior is available, label it as additional evidence rather than a prerequisite for preflight.

## Core discipline

Produce inspectable claims and evidence, not hidden chain-of-thought. For every material statement about the system:

- Cite the exact file, symbol, type, field, route, schema, configuration, or call site when available.
- Label it as **Fact**, **Inference**, **Assumption**, or **Unknown**.
- Never present an inferred or imagined component as an existing fact.
- Preserve ambiguity when the repository does not establish an answer.

Make every correctness obligation falsifiable. Prefer externally observable behavior and preserved invariants over implementation preferences.

## Workflow

### 1. Establish the intent contract

Restate the request as observable outcomes. Separate:

- required behavior;
- constraints and invariants;
- relevant failure behavior;
- non-goals;
- ambiguous decisions that would materially change the result.

Do not silently resolve material ambiguity. Ask only when a choice cannot be grounded in the request or repository and would produce meaningfully different behavior. Otherwise record a conservative assumption.

### 2. Build a grounded system model

Inspect the smallest sufficient portion of the repository. Identify the concrete objects involved in producing the requested behavior, such as entry points, handlers, state, data transformations, consumers, integration boundaries, persistence, configuration, and error paths.

Record exact evidence. Follow data and control relationships far enough to identify what ultimately produces each observable outcome. Do not stop at similarly named or structurally compatible objects.

### 3. Define correctness obligations

Create numbered obligations `O1`, `O2`, and so on. Each obligation must state one property that must hold for the user's intent to be fulfilled.

Include only relevant categories:

- intended happy-path behavior;
- integration and registration behavior;
- state or data propagation;
- failure and recovery behavior;
- preservation of existing behavior or data;
- lifecycle, authorization, concurrency, or persistence requirements when material.

Do not equate “the code compiles,” “a component exists,” or “a function is called” with fulfillment unless that is the actual requested outcome.

### 4. Express the proposed change

Describe the proposed implementation as an ordered, structured change expression. Give every step an identifier `S1`, `S2`, and so on:

```yaml
S1:
  target: exact file and symbol
  operation: create | modify | remove | connect | migrate
  requires: facts or prior steps required
  produces: semantic effect of this step
  preserves: behavior or data that must remain unchanged
  covers: [O1, O3]
```

Name exact targets when the repository supports them. Mark unresolved targets as unknown instead of inventing filenames or symbols.

### 5. Construct the correctness argument

For every obligation, connect the relevant input or trigger to the observable result through the actual and proposed system objects. Use the causal shape that fits the system; a common form is:

```text
trigger/input → handler/decision → transformation or state effect
→ consumer/integration point → observable result
```

The chain need not contain every category, but it must not contain an unexplained gap. Link every edge to a current fact, a proposed step, or an explicit assumption.

Reject circular arguments such as “the feature works because the feature is implemented.” Reject name similarity or structural isomorphism as evidence that two objects have the same runtime or semantic role.

### 6. Attempt to refute the plan

Run a separate adversarial pass. Try to construct plausible cases in which all proposed edits are made but an obligation still fails. Examine only relevant risks, including:

- a producer and consumer using different sources of truth;
- a component being created but not registered or reachable;
- the success path working while failure, retry, or empty states do not;
- state being updated but not persisted, propagated, invalidated, or observed;
- an assumption about identity, ordering, lifecycle, permissions, or configuration being false;
- a local change satisfying one layer while an integration boundary still violates the intent;
- collateral behavior or data changing outside the requested scope.

Add any surviving counterexample as a missing obligation, a revised step, or an unresolved condition. Do not manufacture generic risks merely to lengthen the artifact.

### 7. Assign a verdict

Use exactly one verdict:

- **PASS:** Every obligation has a complete evidence-backed argument, every proposed step covers at least one obligation or justified constraint, and no unresolved contradiction remains.
- **CONDITIONAL:** The argument is complete only if clearly listed assumptions or user decisions hold.
- **FAIL:** An obligation lacks a causal path, evidence contradicts the plan, the plan contains unexplained work, or the intent cannot be evaluated from the available information.

A PASS means “the prospective argument is complete under its stated scope.” It does not mean the code has been proven correct.

### 8. Apply the approval gate

In Preflight mode, stop after presenting the correctness case.

In Implement mode, ask the user to approve or revise the correctness case before editing. Skip the wait only when the user explicitly asked to continue automatically after a PASS. Never implement a FAIL. Implement a CONDITIONAL result only after the relevant assumptions are accepted or resolved.

If repository inspection during implementation invalidates a material fact, obligation, or causal link, stop and revise the correctness case before continuing.

### 9. Reconcile the implementation

After implementation, compare the actual diff with the approved change expression:

- map actual edits back to steps and obligations;
- identify omitted steps;
- identify unplanned edits and justify or revert them as appropriate;
- revise any evidence invalidated by the final code;
- report the post-implementation verdict;
- distinguish LLM assessment from compiler, test, static-analysis, or runtime evidence actually obtained.

Use normal proportional verification after implementation when allowed and useful. Never claim a test, compilation, or runtime check was performed when it was not.

## Required preflight output

Use this compact structure:

```markdown
# Correctness case

## 1. Intent contract
- Required outcomes
- Constraints and invariants
- Relevant failures
- Non-goals

## 2. Grounded system model
| Claim | Exact evidence | Status |
|---|---|---|
| ... | file and symbol | Fact / Inference / Assumption / Unknown |

## 3. Correctness obligations
| ID | Falsifiable obligation | Source |
|---|---|---|
| O1 | ... | User / repository / assumption |

## 4. Change expression
| Step | Exact target | Operation and semantic effect | Covers |
|---|---|---|---|
| S1 | ... | ... | O1 |

## 5. Traceability and argument
| Obligation | Causal chain | Evidence and steps | Verdict |
|---|---|---|---|
| O1 | input → ... → observable | facts + S1 | PASS / CONDITIONAL / FAIL |

## 6. Refutation pass
- Counterexample considered → resolution or surviving gap

## 7. Overall verdict
PASS / CONDITIONAL / FAIL

Scope, assumptions, and the single decision requested from the user.
```

Omit empty sections and collapse trivial cases. Preserve the obligation-to-change and change-to-obligation traceability even in compact output.

## Quality rules

- Keep intent separate from the proposed implementation.
- Require each planned step to justify its existence through an obligation, constraint, or necessary enabling change.
- Require each obligation to be covered by one or more concrete steps or existing behavior.
- Prefer exact repository evidence over plausible framework conventions.
- Surface unknowns instead of repairing the argument with speculation.
- Do not require execution to make a preflight assessment.
- Do not call the artifact a formal proof unless an actual formal system checked it.
- Make the final approval decision easy: approve, revise a named item, accept a condition, or reject.
