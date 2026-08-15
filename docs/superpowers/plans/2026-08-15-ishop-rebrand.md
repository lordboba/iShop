# iShop Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the product to iShop and consistently present the tagline “The shopping agent in your iPhone.”

**Architecture:** Keep runtime behavior and existing filesystem paths intact. Update package metadata, contributor-facing documentation, and the two server-rendered card surfaces; verify the lockfile, rendered branding, ignore coverage, and existing unit suite.

**Tech Stack:** Bun, TypeScript, Hono, server-rendered HTML

---

### Task 1: Rename package and documentation

**Files:**
- Modify: `hackathon/package.json`
- Modify: `hackathon/bun.lock`
- Modify: `hackathon/README.md`
- Modify: `hackathon/AGENTS.md`
- Modify: `docs/superpowers/plans/2026-08-15-mission-shopping-agent.md`

- [x] **Step 1: Change the private package name from `hackathon` to `ishop` in both package metadata files.**
- [x] **Step 2: Replace the scaffold README heading and description with the iShop name, tagline, and a concise product explanation.**
- [x] **Step 3: Update contributor and product-plan headings without renaming historical filesystem paths.**

### Task 2: Brand the rendered cards

**Files:**
- Modify: `hackathon/src/web/cards/mission.ts`
- Modify: `hackathon/src/web/cards/checkout.ts`

- [x] **Step 1: Add a shared `.brand` style and render `iShop · The shopping agent in your iPhone` above each card heading.**
- [x] **Step 2: Prefix both HTML document titles with `iShop` while continuing to HTML-escape mission goals.**

### Task 3: Verify and commit

**Files:**
- Verify: `.gitignore`
- Verify: all files above

- [x] **Step 1: Run `bun test` from `hackathon/`; expect every existing unit test to pass.**
- [x] **Step 2: Run `bunx tsc --noEmit`; expect a zero exit code.**
- [x] **Step 3: Use `git check-ignore -v` for secrets, dependencies, state, build, coverage, cache, and local Claude settings; expect each fixture path to resolve to a repository ignore rule.**
- [x] **Step 4: Inspect `git diff --check`, the scoped diff, and tracked ignored files; expect no whitespace errors, no unrelated staged files, and no tracked secrets/generated output.**
- [x] **Step 5: Commit only the `.gitignore` and iShop rebrand files, leaving pre-existing source/test modifications unstaged.**
