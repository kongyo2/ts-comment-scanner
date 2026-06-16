---
name: tdd
description: Strict t-wada style Red-Green-Refactor TDD for TypeScript + Vitest projects. Use when implementing features, fixing bugs, changing runtime behavior, or refactoring logic — any task that adds or modifies production code. Enforces test-first development with a verified Red, minimal Green, and disciplined Refactor, plus agent-safe Vitest execution rules.
---

# t-wada TDD — TypeScript × Vitest

Practice strict Test-Driven Development in the style of t-wada / Kent Beck. The goal is **動作するきれいなコード — clean code that works**, grown one small verified step at a time.

**No production code without a failing test you have seen fail. No exceptions.**

## Project environment (auto-detected)

- Package manager: !`if [ -f pnpm-lock.yaml ]; then echo pnpm; elif [ -f yarn.lock ]; then echo yarn; elif [ -f bun.lock ] || [ -f bun.lockb ]; then echo bun; elif [ -f package-lock.json ]; then echo npm; else echo "npm (no lockfile found)"; fi`
- Vitest: !`node -p "const p = require('./package.json'); const v = { ...p.dependencies, ...p.devDependencies }.vitest; v ? v : 'NOT found in package.json'" 2>/dev/null || echo "package.json not found"`
- Config: !`found=$(ls vitest.config.* vitest.workspace.* vite.config.* 2>/dev/null); echo "${found:-none found — check package.json or ask the user}"`
- Globals: !`grep -qsE "globals[\"']? *: *true" vitest.config.* vite.config.* 2>/dev/null && echo "enabled — use describe/it/expect/vi without imports" || echo "not detected — import { describe, it, expect, vi } from 'vitest'"`
- Test scripts: !`node -p "Object.entries(require('./package.json').scripts ?? {}).filter(([k]) => k.includes('test')).map(([k, v]) => k + ': ' + v).join('  |  ') || 'none'" 2>/dev/null || echo "package.json not found"`

If anything above is missing or contradicts the repository, read `package.json` and the Vitest config yourself before running tests. Never guess commands.

## Applicability gate (decide first)

| Task | TDD required? |
|------|---------------|
| New feature / new behavior | **Yes** |
| Bug fix | **Yes** — failing regression test first |
| Refactoring logic | **Yes** — green tests before, during, after |
| Changing untested legacy code | **Yes** — characterization tests first (see below) |
| Comments, docs, formatting only | No |
| Pure type declarations with no runtime effect | No — consider type tests (`expectTypeOf`) |
| Config / CI / dependency bumps | No — but run the full suite afterwards |

If the user explicitly opts out of TDD, note the tradeoff in one sentence and follow their instruction. Otherwise this skill is binding.

## Iron rules

1. **Test first, always.** Production code may only be written in response to a failing test you have *watched* fail.
2. **Never start watch mode.** Bare `vitest` (or a `test` script without `run`) can block the session forever. Always use `vitest run …`.
3. **Verify Red before Green.** Run the new test and read the output. It must fail for the *expected reason* — an assertion failure describing the missing behavior, not a typo, broken import, or setup error.
4. **Minimal Green.** Write the least code that passes. Hard-coding is allowed (仮実装); generality is earned through more tests, not anticipated.
5. **Refactor only on green.** Never restructure while any test is red.
6. **Never weaken a test to pass.** No deleting, no loosening assertions, no `.skip` without a written reason. If a test is wrong, fix it and say why.
7. **One behavior per test.** Name the test after the behavior — `it('returns 0 for an empty cart')` — never after the implementation.
8. **Run tests after every Green and every Refactor step.** Affected tests during the cycle, the full suite before declaring done.
9. **Leave no `.only`.** Search and remove before finishing (CI rejects it via `--allowOnly=false`).
10. **Tests are first-class code.** Same naming and readability standards — but DAMP over DRY: duplication in tests is fine when it makes intent clearer.

## The cycle

```
探索 Explore → Plan (test list) → 🔴 Red → 🟢 Green → 🔵 Refactor → next item … → Done
```

### 探索 Explore

Read the relevant code, types, and existing tests before planning. If an unfamiliar API needs investigation, a throwaway spike is allowed — but spike code must be deleted or rebuilt test-first before integration. Never promote untested spike code to production.

### Plan — write the test list

1. Decompose the task into small, independently verifiable behaviors.
2. Order them simplest and most fundamental first. Include edge cases: empty, zero, negative, boundaries, error paths.
3. Record the list as `it.todo(…)` placeholders in the test file and mirror it in your task tracker.
4. The list is alive: append discoveries as you go; never silently drop an item.

```typescript
describe('calculateTotal', () => {
	it.todo('returns 0 for an empty cart');
	it.todo('sums item prices');
	it.todo('applies percentage discount');
	it.todo('never returns a negative total');
});
```

### 🔴 Red — one failing test

1. Pick **one** item from the list.
2. Write the test **assert-first**: write the `expect` line, then work backwards to the setup. Expected values are concrete literals — never computed with the logic you are about to implement.
3. If the code under test does not exist yet, add only a minimal skeleton (exported stub with the right signature) so the failure is an **assertion failure**, not a compile error.
4. Run only that test:
   - `npx vitest run src/cart.test.ts`
   - `npx vitest run -t "applies percentage discount"`
5. **Gate:** read the failure output and confirm it fails for the expected reason. If the test passes immediately, stop — either the behavior already exists or the test asserts nothing. Investigate before proceeding.

### 🟢 Green — minimal pass

Pick the smallest workable strategy:

| Strategy | When | How |
|----------|------|-----|
| 仮実装 (Fake It) | Unsure how to implement | Return a hard-coded constant; generalize later |
| 三角測量 (Triangulation) | The fake must become real | Add a second test with different values the constant cannot satisfy, then generalize |
| 明白な実装 (Obvious Implementation) | Implementation is trivial and certain | Just write it — if it does not go green immediately, fall back to smaller steps |

Run the affected tests. **Gate:** the new test passes and nothing else broke. Speed to green beats elegance — sins committed here are repaid in Refactor.

### 🔵 Refactor — clean up on green

1. Remove duplication — including duplication **between test and production code** (the same `90` appearing in both is the signal to generalize a fake).
2. Improve names, extract functions, simplify structure. Refactor test code too.
3. After **each** small step, rerun affected tests. Green → continue. Red → revert that step immediately; do not debug forward.
4. Tidy First: when committing, keep structural changes (rename / move / extract) in separate commits from behavioral changes. Commit only on green.

Then return to the list and pick the next item.

### Done — definition of done

- [ ] Every test-list item is implemented or explicitly deferred as `it.todo` (tell the user which)
- [ ] Full suite green: `npx vitest run`
- [ ] No `.only`; every `.skip` carries a reason comment
- [ ] Typecheck passes (`tsc --noEmit` or the project's script); lint passes if configured
- [ ] Test names alone read as a specification of the new behavior

## When stuck

- **No green after ~3 attempts** → the step is too big. Revert to the last green state, split the behavior smaller, retry.
- **Refactor broke a test** → revert the refactoring and take a smaller step. Never debug forward on red.
- **Unrelated tests started failing** → stop; treat that as the current Red. No shotgun fixes.
- **Flaky test** → quarantine with `it.skip` + a reason comment + a list item, and report it. Never delete it.
- **Genuinely blocked** → report the test-list state honestly instead of forcing green.

## Progress reporting

Report each cycle compactly so the user can follow along:

```
🔴 applies percentage discount — fails as expected (expected 90, received 100)
🟢 pass (7 tests, 112ms) — fake-it with constant
🔵 generalized via triangulation; extracted applyDiscount() — all green
```

## Untested legacy code

Before changing behavior in code that has no tests: pin the *current* behavior with **characterization tests** — assert what the code actually does today, even if it looks wrong, and report oddities to the user instead of silently "fixing" them. Once green, proceed with the normal cycle.

## References (load on demand)

- [vitest.md](references/vitest.md) — agent-safe CLI usage, modifiers, matchers, async patterns, type tests, snapshots, coverage
- [test-style.md](references/test-style.md) — readable test patterns: AAA, naming, `it.each`, fixtures, assertion style
- [mocking.md](references/mocking.md) — test-double policy and `vi.*` usage: mock boundaries, not your own logic
- [anti-patterns.md](references/anti-patterns.md) — catalog of TDD violations with corrections
