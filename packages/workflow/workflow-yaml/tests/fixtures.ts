/** The two v1 example workflows (with `version: 1`, without `evidence`). */

export const FEATURE_LOOP = `version: 1
name: feature-loop
description: Plan, implement until checks pass, review, and ask for approval.
when_to_use: Use for a self-contained feature with a typecheck and test command.
inputs:
  feature:
    type: string
    required: true
    description: What to build.
defaults:
  tier: standard
  retry:
    max_attempts: 2
    delay_ms: 1000
nodes:
  - id: plan
    kind: prompt
    label: Plan the work
    phase: Plan
    prompt: |
      Write a short implementation plan for: $inputs.feature
    mutates_checkout: false
  - id: implement
    kind: loop
    depends_on: [plan]
    phase: Implement
    prompt: |
      Implement the plan.
      $plan.output
    until_bash: pnpm run typecheck && pnpm run test
    max_iterations: 5
  - id: gate-tests
    kind: bash
    depends_on: [implement]
    bash: pnpm run test
    timeout_ms: 300000
  - id: review
    kind: prompt
    depends_on: [gate-tests]
    tier: cheap
    gate: true
    mutates_checkout: false
    output_format:
      type: object
      properties:
        pass: { type: boolean }
        reasons: { type: string }
    prompt: |
      Review the change. Quote the command you ran and its exit code.
  - id: pass-check
    kind: bash
    depends_on: [review]
    when: $review.output.pass == true
    bash: echo "review passed"
  - id: approve
    kind: approval
    depends_on: [pass-check]
    message: Review passed. Merge the change?
  - id: stop-on-reject
    kind: cancel
    depends_on: [approve]
    trigger_rule: all_done
    when: $approve.status == 'failed'
    reason: The reviewer rejected the change.
`

export const MAIL_TRIAGE = `version: 1
name: mail-triage
description: Fetch mail, classify it, draft replies to urgent items, and ask before sending.
inputs:
  folder:
    type: string
    default: inbox
nodes:
  - id: fetch
    kind: bash
    bash: mail-cli list --folder "$inputs.folder" --json
    env:
      MAIL_PAGER: cat
  - id: classify
    kind: prompt
    depends_on: [fetch]
    tier: cheap
    mutates_checkout: false
    output_format:
      type: object
      properties:
        urgent: { type: array }
    prompt: |
      Classify these messages and list the urgent ones.
      $fetch.output
  - id: draft
    kind: prompt
    depends_on: [classify]
    when: $classify.output.urgent
    mutates_checkout: false
    prompt: |
      Draft a reply for each urgent message.
      $classify.output.urgent
  - id: approve-send
    kind: approval
    depends_on: [draft]
    message: Send the drafted replies?
    timeout_ms: 1800000
  - id: send
    kind: bash
    depends_on: [approve-send]
    bash: mail-cli send --drafts "$draft.output"
`
