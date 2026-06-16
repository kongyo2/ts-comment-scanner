# Vitest reference — agent-safe execution & API

## Running tests (critical)

**Never start watch mode.** Bare `vitest` enters watch mode in interactive terminals and never exits. Always pass `run` explicitly — do not rely on CI/TTY auto-detection.

| Goal | Command |
|------|---------|
| One file (default during the cycle) | `npx vitest run src/cart.test.ts` |
| One test by name | `npx vitest run -t "applies percentage discount"` |
| One test by line number | `npx vitest run src/cart.test.ts:42` |
| Tests affected by uncommitted changes | `npx vitest run --changed` |
| Tests affected since a git ref | `npx vitest run --changed HEAD~1` |
| Tests covering specific source files | `npx vitest related src/cart.ts --run` |
| Full suite (Done phase) | `npx vitest run` |
| Stop at first failure | `npx vitest run --bail=1` |
| Coverage | `npx vitest run --coverage` |
| Type tests | `npx vitest run --typecheck` |
| Hide passed-test noise (Vitest 3.1+) | `npx vitest run --silent=passed-only` |

Notes:

- Substitute the detected package manager: `pnpm vitest run …`, `yarn vitest run …`, `bunx vitest run …`.
- `npm test` is safe only if the `test` script itself contains `run` — check the detected scripts in [SKILL.md](../SKILL.md) first.
- `vitest related` follows static imports only; dynamic `import(path)` is not traced.
- **Never pass `-u` / `--update`** to refresh snapshots unless you have read every snapshot diff and the change is intentional.

## Globals

Check the config (see [SKILL.md](../SKILL.md) detection). With `globals: true`, use `describe / it / expect / vi / beforeEach / assert` directly. Otherwise import explicitly:

```typescript
import { assert, beforeEach, describe, expect, it, vi } from 'vitest';
```

## Test modifiers

Use modifiers instead of commenting out or deleting tests:

- `it.todo('…')` — placeholder for the test list. Sketch behaviors before implementing.
- `it.skip('…', fn)` — temporarily disable. **Always** add a `// skip reason: …` comment.
- `it.fails('…', fn)` — asserts the test *does* fail. Documents a known bug while keeping the suite green.
- `it.only('…', fn)` — focus during the cycle. **Must be removed before Done** (CI fails on leftover `.only` because `--allowOnly` defaults to false there).
- `it.each(table)('…', fn)` — parameterize **one** behavior across inputs (see [test-style.md](test-style.md) for when not to).
- `test.for(table)('…', (case, { expect }) => …)` — like `each`, but plays well with fixtures and concurrent-safe `expect`.
- `it.skipIf(cond)` / `it.runIf(cond)` — environment-conditional execution.
- `it.concurrent` / `it.sequential` — parallelism control; use `sequential` when tests share state.
- `test.extend({ … })` — define reusable fixtures for shared setup.

Modifiers chain: `it.skip.concurrent(…)`, `it.fails.only(…)`.

Full API: https://vitest.dev/api/

## Matchers — the short list

```typescript
expect(x).toBe(1);                          // primitives & reference identity
expect(obj).toEqual({ a: 1 });              // deep structural equality
expect(obj).toStrictEqual({ a: 1 });        // + undefined keys, class identity
expect(obj).toMatchObject({ a: 1 });        // subset match (use sparingly)
expect(arr).toContain('x');                 // primitive membership
expect(arr).toContainEqual({ id: 1 });      // deep membership
expect(arr).toHaveLength(3);
expect(0.1 + 0.2).toBeCloseTo(0.3);         // floats — never toBe
expect(fn).toThrow(RangeError);             // wrap calls: () => fn(arg)
expect(v).toBeNull(); expect(v).toBeUndefined(); expect(v).toBeDefined();
```

Asymmetric matchers for "don't care" parts:

```typescript
expect(user).toEqual({
	id: expect.any(String),
	createdAt: expect.any(Date),
	name: 'Alice',
});
expect(payload).toEqual(expect.objectContaining({ status: 'ok' }));
expect(log).toEqual(expect.arrayContaining(['started']));
expect(message).toEqual(expect.stringMatching(/^ERR-\d+/));
```

## Async

```typescript
await expect(loadUser('u1')).resolves.toEqual({ id: 'u1' });
await expect(loadConfig('bad.json')).rejects.toThrow(ValidationError);

// Poll a value until it matches (external/eventual state)
await expect.poll(() => queue.size()).toBe(0);

// Retry an assertion block until it passes
await vi.waitFor(() => expect(handler).toHaveBeenCalled());
```

Never `await new Promise(r => setTimeout(r, …))` in a test — use fake timers ([mocking.md](mocking.md)) or the helpers above.

## Type tests

For behavior that lives in the type system (generics, inference, overloads):

```typescript
import { expectTypeOf } from 'vitest';

it('infers row tuples from the header', () => {
	expectTypeOf(parseCsv('a,b')).toEqualTypeOf<[string, string][]>();
	// @ts-expect-error — rejects a non-string header
	parseCsv(42);
});
```

Run with `npx vitest run --typecheck`. Type tests follow the same Red-Green discipline: see the type error first, then fix the types.

## Snapshots — policy

Prefer explicit assertions. When a snapshot is genuinely the right tool (serialized output formats, error messages), use `toMatchInlineSnapshot()` so the expectation lives inside the test, and keep the snapshotted value small and focused. Review every diff; never bulk-update.

## Coverage

```bash
npx vitest run --coverage     # requires @vitest/coverage-v8 (or -istanbul)
```

Coverage is a **byproduct** of behavior-driven tests, not a target. To raise it, find untested *behaviors* in the report and drive them with the normal Red-Green-Refactor cycle. Never add assertion-free tests that merely execute lines — see [anti-patterns.md](anti-patterns.md) § Coverage gaming.
