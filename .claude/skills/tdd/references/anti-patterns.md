# TDD anti-patterns — recognize and correct

Each entry: the smell, why it is harmful, the fix. When you catch yourself mid-anti-pattern, stop, revert to the last green state, and restart the step correctly.

## 1. Test-after (backfilling)

**Smell:** Production code is written first; tests are added afterwards to "cover" it.
**Harm:** Tests written after the fact mirror the implementation instead of specifying behavior, and they have never been seen to fail — so they may assert nothing.
**Fix:** Stop. If code already exists untested, comment it out or stash it, write the failing test, then restore the code as the Green step.

## 2. Unverified Red

**Smell:** Writing the test and the implementation in one pass, assuming the test "would have failed".
**Harm:** A test that never failed may be tautological, mis-wired, or asserting the wrong thing. This is the single most common way agents fake TDD.
**Fix:** Always run the new test alone and read the failure message before writing any production code. `expected 90, received 100` is a verified Red; `Cannot find module` is not.

## 3. Giant step

**Smell:** One test demands an entire feature; Green takes dozens of lines and several attempts.
**Harm:** Long red periods, no feedback, thrashing.
**Fix:** After ~3 failed Green attempts, revert to green and split the behavior. A good step is implementable in minutes.

## 4. Weakening a test to pass

**Smell:** Deleting a failing test, replacing `toEqual` with `toMatchObject`, widening `toBeCloseTo` precision, or adding `.skip` — just to make the build green.
**Harm:** The suite now certifies behavior nobody specified. This silently destroys the safety net.
**Fix:** A red test means the code is wrong or the test is wrong. If the test is wrong, fix it and state the reason explicitly to the user. Loosening is only valid when the *specification* genuinely loosened.

## 5. Content-existence tests

**Smell:** `expect(skillMd).toContain('some guidance')` — asserting that a document, prompt, or config merely *contains* certain words.
**Harm:** Freezes wording without proving anything works; every harmless rephrase breaks the build.
**Fix:** Test the executable contract instead (the parser accepts the file, the loader resolves the path, the rendered output behaves). If there is no executable contract, the file does not need a unit test.

## 6. Testing implementation details

**Smell:** Asserting private state, internal call sequences, or that helper X called helper Y.

```typescript
// Bad — breaks on any internal refactor
expect(cart['_items']).toHaveLength(2);
expect(recalcSpy).toHaveBeenCalledBefore(persistSpy);

// Good — observable behavior through the public interface
expect(cart.total()).toBe(30);
```

**Fix:** Test through the public interface. If something feels untestable without reaching inside, that is a design signal — extract it into its own unit with its own public interface.

## 7. Recomputed expectations

**Smell:** The expected value is calculated with the same algorithm being tested (`expect(sum(xs)).toBe(xs.reduce(...))`).
**Harm:** The test passes even when the algorithm is wrong — both sides share the bug.
**Fix:** Hard-code expected literals computed by hand. See [test-style.md](test-style.md).

## 8. Conditional logic in tests

**Smell:** `if` / `switch` / loops with branching assertions inside a test body.
**Harm:** Some branches never execute; the test verifies different things on different days.
**Fix:** One behavior per test; `it.each` only when every case shares the same assertion shape.

## 9. Order-dependent tests / shared mutable state

**Smell:** Tests pass with `vitest run` but fail alone, shuffled, or with `--sequence.shuffle`.
**Harm:** Cascading false failures; impossible to trust any single result.
**Fix:** Fresh fixtures per test; `restoreMocks`/`unstubEnvs` in config; no module-level mutable state (see [test-style.md](test-style.md) and [mocking.md](mocking.md)).

## 10. Over-mocking your own code

**Smell:** Mocking the module right next door; tests that are 80% mock setup; mocks of mocks.
**Harm:** The suite verifies a conversation between mocks, not the system. Real integration bugs sail through.
**Fix:** Mock only boundaries (time, network, fs, randomness, external SDKs). Use real collaborators you own; inject dependencies instead of `vi.mock` where possible.

## 11. Snapshot abuse

**Smell:** `toMatchSnapshot()` on large objects as the primary assertion; running `vitest -u` to "fix" failures without reading diffs.
**Harm:** Nobody knows what the snapshot guarantees; blind `-u` converts a regression into a new baseline.
**Fix:** Explicit assertions first; small `toMatchInlineSnapshot` where serialization is the behavior; never update a snapshot you have not read.

## 12. Sleep-based async

**Smell:** `await new Promise(r => setTimeout(r, 500))` waiting for something to happen.
**Harm:** Slow when generous, flaky when tight — usually both over time.
**Fix:** `vi.useFakeTimers()` + `advanceTimersByTimeAsync`, or `await vi.waitFor(...)` / `expect.poll(...)` for genuine eventual state.

## 13. Coverage gaming

**Smell:** Tests that call functions but assert nothing (or only `toBeDefined()`), added purely to push a coverage number.
**Harm:** Coverage rises while the safety net stays the same size; the metric is now lying.
**Fix:** Coverage is a byproduct. Read the coverage report to *find unspecified behaviors*, then drive each one through a normal Red-Green-Refactor cycle with a real assertion.

## 14. `.only` / silent `.skip` leftovers

**Smell:** Committing `it.only` (everything else silently stops running) or `it.skip` with no explanation.
**Harm:** `.only` collapses the suite to one test on every machine; an unexplained skip rots forever.
**Fix:** Grep for `.only(` before Done. Every `.skip` carries `// skip reason: …` plus an `it.todo` or task-list entry to un-skip it.

## 15. Committing on red

**Smell:** Committing or handing off while tests fail, "to save progress".
**Harm:** Breaks bisect, blocks teammates, and normalizes a red baseline.
**Fix:** Commit only on green. If you must checkpoint mid-step, stash — or revert to the last green and re-take a smaller step.

## 16. Characterization tests as approval rubber-stamps

**Smell:** Snapshotting legacy output wholesale and treating "matches yesterday" as correctness.
**Harm:** Bugs get enshrined as specifications without anyone deciding so.
**Fix:** Characterization tests pin current behavior *deliberately*: assert specific observed values, flag suspicious ones to the user, and replace them with real specifications as understanding grows.
