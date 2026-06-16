# Test style — tests that read as specifications

Each test should read like a one-sentence specification of behavior. When you cannot name a test clearly, the behavior is not yet understood — go back to the test list.

## Anatomy: Arrange-Act-Assert

One block each, separated by blank lines. One Act per test.

```typescript
it('applies a percentage discount to the subtotal', () => {
	const cart = [{ price: 100 }];                       // Arrange

	const total = calculateTotal(cart, { percentOff: 10 }); // Act

	expect(total).toBe(90);                              // Assert
});
```

Multiple `expect` lines are fine when they verify facets of the **same** behavior. Two behaviors means two tests.

## Naming

- Name the behavior, not the implementation: `it('returns 0 for an empty cart')`, never `it('test calculateTotal')`.
- Write a sentence that completes "it …". The suite output becomes living documentation.
- Natural-language names in the team's language are encouraged — `it('空のカートでは0を返す')` is a fine t-wada-style name if the codebase uses Japanese.
- Test files are `*.test.ts`, colocated with the implementation `*.ts` they specify.

## Hard-code expected values

Never compute the expectation with the logic under test — that proves nothing.

Bad:

```typescript
it('sums item prices', () => {
	const items = [{ price: 10 }, { price: 20 }];

	expect(calculateTotal(items)).toBe(items.reduce((s, i) => s + i.price, 0));
});
```

Good:

```typescript
it('sums item prices', () => {
	const items = [{ price: 10 }, { price: 20 }];

	expect(calculateTotal(items)).toBe(30);
});
```

## No branching inside tests

`if` inside a test body means two behaviors are hiding in one test. Split them, or use `it.each` when it is truly one behavior.

Bad:

```typescript
it('formats output', () => {
	const output = formatReport(mode);

	if (mode === 'json') {
		expect(JSON.parse(output)).toEqual(expected);
	} else {
		expect(output).toContain('Total');
	}
});
```

Good:

```typescript
it('formats JSON output', () => {
	const output = formatReport('json');

	expect(JSON.parse(output)).toEqual(expected);
});

it('formats table output', () => {
	const output = formatReport('table');

	expect(output).toContain('Total');
});
```

The same goes for loops that generate assertions — prefer `it.each` so each case fails independently with its own name.

## No try/catch for expected failures

Bad:

```typescript
it('rejects invalid config', async () => {
	try {
		await loadConfig('bad.json');
		expect.fail('expected loadConfig to throw');
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
	}
});
```

Good:

```typescript
it('rejects invalid config', async () => {
	await expect(loadConfig('bad.json')).rejects.toThrow(Error);
});
```

For synchronous code, wrap the call: `expect(() => parse('}{')).toThrow(SyntaxError)`.

## `it.each` only when cases share one behavior

Good:

```typescript
it.each([
	['daily', '2026-05-16'],
	['monthly', '2026-05'],
])('groups %s rows by period', (reportType, expectedPeriod) => {
	const rows = groupUsage(reportType, usage);

	expect(rows[0]?.period).toBe(expectedPeriod);
});
```

If the cases need different assertions or different setup, they are different behaviors — write separate tests.

## Helpers must not hide the behavior

A wrapper that contains the Act and the Assert makes the test unreadable and the failure unlocatable.

Bad:

```typescript
function expectReport(input: UsageEntry[], expected: ReportRow[]) {
	expect(renderDaily(input)).toEqual(expected);
}

it('renders daily totals', () => {
	expectReport(
		[{ timestamp: '2026-05-16T10:00:00Z', inputTokens: 100 }],
		[{ date: '2026-05-16', inputTokens: 100 }],
	);
});
```

Good:

```typescript
it('renders daily totals', () => {
	const input = [{ timestamp: '2026-05-16T10:00:00Z', inputTokens: 100 }];

	expect(renderDaily(input)).toEqual([{ date: '2026-05-16', inputTokens: 100 }]);
});
```

Helpers **are** welcome for noisy fixture construction. Keep the Act and Assert in the test body.

```typescript
function buildUser(overrides: Partial<User> = {}): User {
	return { id: 'u1', name: 'Alice', role: 'member', createdAt: new Date(0), ...overrides };
}

it('denies deletion to non-admins', () => {
	const user = buildUser({ role: 'member' });

	expect(canDelete(user)).toBe(false);
});
```

The builder also enforces **minimal relevant data**: the test mentions only the field the behavior cares about (`role`), and the noise lives in one place.

## `assert` for preconditions, never non-null `!`

A non-null assertion silences TypeScript and fails with a useless message. `assert` narrows the type *and* explains the failure.

Bad:

```typescript
it('returns the first row', () => {
	const rows = getRows();

	expect(rows[0]!.id).toBe('row-1');
});
```

Good:

```typescript
it('returns the first row', () => {
	const rows = getRows();
	const firstRow = rows[0];
	assert.isDefined(firstRow, 'expected at least one row');

	expect(firstRow.id).toBe('row-1');
});
```

Also good for exports that may be tree-shaken or conditionally defined:

```typescript
assert.isDefined(backendTrpcFetch, 'backendTrpcFetch should be defined');
const backendFetch = backendTrpcFetch;
```

## Fresh state per test

Tests must pass in any order and in isolation. Build mutable data inside the test (or in `beforeEach`); never share a mutable module-level fixture.

Bad:

```typescript
const cart: Item[] = [];          // shared and mutated across tests

it('adds an item', () => {
	cart.push({ price: 10 });
	expect(cart).toHaveLength(1);
});

it('starts empty', () => {
	expect(cart).toHaveLength(0);   // passes or fails depending on order
});
```

Good: construct `const cart: Item[] = []` inside each test, or reassign it in `beforeEach`. Frozen constants (`as const`) may be shared safely.

## DAMP over DRY

Duplication between tests is acceptable when it makes each test self-contained and obvious. Refactor test code only when there is a clear readability benefit — never to a point where understanding one test requires reading three helpers.
