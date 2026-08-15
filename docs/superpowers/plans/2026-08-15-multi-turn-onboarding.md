# Multi-Turn Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve partial shopping briefs across messages so short onboarding answers converge on one mission without repeated budget, currency, or country questions.

**Architecture:** `parseMission` will return a normalized `MissionDraft` even when the mission is incomplete. The per-space loop session will retain that draft, pass it into the next parse, and clear it only after mission creation. US/USD are product defaults for the current demo, while required fields and clarification text are computed in application code.

**Tech Stack:** TypeScript, Bun, Zod, OpenAI Responses API, Spectrum.

---

### Task 1: Preserve incomplete mission data

**Files:**
- Modify: `hackathon/src/agent/mission-parser.ts`
- Modify: `hackathon/src/agent/prompts.ts`
- Test: `hackathon/tests/mission-parser.test.ts`

- [x] **Step 1: Write the failing parser regression test**

Add a test proving an incomplete parse returns a reusable draft instead of discarding a recognized goal or budget.

- [x] **Step 2: Run the parser test and verify RED**

Run: `bun test tests/mission-parser.test.ts`

Expected: FAIL because `ParseResult` does not yet contain a partial draft.

- [x] **Step 3: Implement the normalized draft contract**

Add a model-facing draft with nullable `goal`, `countryCode`, and budget currency; normalize missing market data to `US`/`USD`; merge a previous draft; compute required fields in code; return the draft on incomplete parses and a `ShoppingMission` on complete parses.

- [x] **Step 4: Run the parser tests and verify GREEN**

Run: `bun test tests/mission-parser.test.ts`

Expected: all parser tests pass.

### Task 2: Accumulate drafts in the message loop

**Files:**
- Modify: `hackathon/src/agent/loop.ts`
- Test: `hackathon/tests/loop.test.ts`

- [x] **Step 1: Write the failing screenshot-transcript regression test**

Model the two-turn `250` then `Clothes` sequence and prove the second parse receives the first turn's draft, produces a complete mission, and never asks for country or currency.

- [x] **Step 2: Run the loop/parser regression and verify RED**

Run: `bun test tests/mission-parser.test.ts tests/loop.test.ts`

Expected: FAIL because `SpaceSession` currently stores only an image and card message.

- [x] **Step 3: Save and clear the per-space draft**

Store `parsed.draft` whenever a mission remains incomplete, pass `session.draft` into the next parse, use deterministic acknowledgment-aware clarification copy, and clear the draft after a mission starts.

- [x] **Step 4: Run targeted tests and verify GREEN**

Run: `bun test tests/mission-parser.test.ts tests/loop.test.ts`

Expected: all targeted tests pass.

### Task 3: Verify and commit the focused change

**Files:**
- Modify: `hackathon/src/agent/mission-parser.ts`
- Modify: `hackathon/src/agent/prompts.ts`
- Modify: `hackathon/src/agent/loop.ts`
- Modify: `hackathon/src/CONTRACTS.md`
- Modify: `hackathon/tests/mission-parser.test.ts`
- Modify: `hackathon/tests/loop.test.ts`

- [x] **Step 1: Run the full suite and type-check**

Run: `bun test && bunx tsc --noEmit`

Expected: zero failures and zero type errors.

- [x] **Step 2: Review the diff and staged scope**

Confirm unrelated Shopify and web-server changes remain unstaged.

- [ ] **Step 3: Commit only onboarding files**

Run: `git add docs/superpowers/plans/2026-08-15-multi-turn-onboarding.md hackathon/src/CONTRACTS.md hackathon/src/agent/mission-parser.ts hackathon/src/agent/prompts.ts hackathon/src/agent/loop.ts hackathon/tests/mission-parser.test.ts hackathon/tests/loop.test.ts`

Run: `git commit -m "fix: preserve multi-turn shopping onboarding"`
