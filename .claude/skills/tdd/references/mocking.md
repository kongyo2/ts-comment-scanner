# Mocking — boundaries only

## Policy first

Mock the things you do not control. Use the real thing for the logic you own.

| Mock (boundary) | Do NOT mock |
|-----------------|-------------|
| Time / clock (`Date`, timers) | The unit under test itself |
| Randomness (`Math.random`, `crypto`) | Your own pure functions and domain logic |
| Network (HTTP, RPC clients) | Simple collaborators that are fast and deterministic |
| Filesystem, process env | Language and stdlib built-ins (`Array`, `JSON`, …) |
| Third-party SDKs and external services | Types — fix the design instead |

Every mock encodes an assumption about a contract; when the real contract drifts, the test keeps passing while production breaks. Each mock must therefore pay for itself in determinism or speed.

**Prefer dependency injection over module mocking.** If a function is hard to test, pass the dependency in — the design improves and `vi.mock` becomes unnecessary:

```typescript
// Hard to test: reaches for the global clock
export function isExpired(token: Token): boolean {
	return token.expiresAt < Date.now();
}

// Easy to test: the clock is injected
export function isExpired(token: Token, now: number = Date.now()): boolean {
	return token.expiresAt < now;
}

it('treats a token expiring exactly now as expired', () => {
	expect(isExpired({ expiresAt: 1000 }, 1000)).toBe(false);
	expect(isExpired({ expiresAt: 999 }, 1000)).toBe(true);
});
```

## `vi.fn` — function doubles

```typescript
const onSave = vi.fn();
const fetchUser = vi.fn().mockResolvedValue({ id: 'u1' });
const nextId = vi.fn()
	.mockReturnValueOnce('id-1')
	.mockReturnValueOnce('id-2');
const compute = vi.fn().mockImplementation((n: number) => n * 2);
```

## `vi.spyOn` — observe or override an existing method

```typescript
const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

expect(spy).toHaveBeenCalledWith(expect.stringContaining('deprecated'));

spy.mockRestore(); // or rely on restoreMocks (see Cleanup)
```

## `vi.mock` — module replacement (last resort)

`vi.mock` calls are **hoisted** to the top of the file before imports run. Variables used inside the factory must be created with `vi.hoisted`:

```typescript
const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock('./mailer', () => ({ sendMail }));

it('notifies the owner on failure', async () => {
	await processJob(failingJob);

	expect(sendMail).toHaveBeenCalledWith(
		expect.objectContaining({ to: 'owner@example.com' }),
	);
});
```

Partial mock — keep the real module, override one export:

```typescript
vi.mock('./pricing', async (importActual) => ({
	...(await importActual<typeof import('./pricing')>()),
	fetchExchangeRate: vi.fn().mockResolvedValue(1.5),
}));
```

Typed access to a mocked import: `vi.mocked(fetchExchangeRate).mockResolvedValue(2)`.

For HTTP specifically, prefer `msw` (if the project uses it) or an injected `fetch` over mocking your own API-client module — intercepting at the network boundary keeps your client code under test.

## Fake timers and dates

```typescript
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-06-10T00:00:00Z'));
});

afterEach(() => {
	vi.useRealTimers();
});

it('emits a reminder after 30 minutes', async () => {
	const onRemind = vi.fn();
	scheduleReminder(onRemind, { minutes: 30 });

	await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

	expect(onRemind).toHaveBeenCalledTimes(1);
});
```

Use `advanceTimersByTimeAsync` / `runAllTimersAsync` when timer callbacks contain promises. Never sleep with a real `setTimeout` in tests.

## Environment and globals

```typescript
vi.stubEnv('API_URL', 'http://localhost:9999');
vi.stubGlobal('crypto', { randomUUID: () => 'fixed-uuid' });
// cleanup: vi.unstubAllEnvs(); vi.unstubAllGlobals();
```

## Cleanup — clear vs reset vs restore

| Call | Call history | Implementation / return values | Spied original |
|------|--------------|--------------------------------|----------------|
| `vi.clearAllMocks()` | cleared | kept | not restored |
| `vi.resetAllMocks()` | cleared | removed | not restored |
| `vi.restoreAllMocks()` | cleared | removed | **restored** |

Recommended: set it once in the Vitest config so no test leaks into the next —

```typescript
// vitest.config.ts → test: { … }
{ restoreMocks: true, unstubEnvs: true, unstubGlobals: true }
```

If the config cannot be changed, put `afterEach(() => { vi.restoreAllMocks(); })` in the test file.

## Asserting calls — don't over-specify

```typescript
expect(sendMail).toHaveBeenCalledTimes(1);
expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@example.com' }));
```

Assert only what the behavior promises. Pinning exact call order, exact counts of incidental calls, or full argument objects that include irrelevant fields turns refactoring into test churn — that is testing the implementation, not the behavior (see [anti-patterns.md](anti-patterns.md)).
