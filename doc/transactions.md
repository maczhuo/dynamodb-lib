# DynamoDBTransaction method reference

[Documentation index](README.md) · [Service reference](service.md) · [Expression builders](expressions.md)

## Creating a transaction

Prefer `db.transaction({ mode, now?, returnConsumedCapacity? })`. It reuses the service's document client, configured tables, logger and conflict retry settings.

```ts
import { DynamoDBTransactionMode } from '@jzhuo3/dynamodb-lib';

const tx = db.transaction({ mode: DynamoDBTransactionMode.WRITE });
```

READ mode accepts only `getOne`; WRITE mode accepts `check`, `createOne`, `update` and `deleteOne`. These methods queue operations synchronously and return the same transaction for chaining. Nothing is sent until `commit()`.

The current library caps each transaction at 25 operations. Use separate target items for separate write actions in one transaction; place a condition on an item's `update` instead of adding a separate `check` for that same item. Build a nonempty transaction before committing. Keep the mode unchanged after creation and do not commit one transaction object concurrently.

## `getOne(tableKey, primaryKey, opts = {})`

READ only. Queues a read for one full primary key. `opts` accepts only `projectionFields?: string[]`. Results are returned by `commit<T>()`, not by `getOne` itself.

```ts
const result = await db.transaction({ mode: DynamoDBTransactionMode.READ })
  .getOne('users', 'user-1', { projectionFields: ['DisplayName'] })
  .getOne('users', 'user-2')
  .commit<{ displayName?: string }>();
```

The output preserves queued order; missing or expired items become `null`. Expiry uses the fixed `now` captured when creating the transaction. The TTL attribute is fetched when needed and retained in returned transaction items, including when it was not explicitly projected. Casing is selected once at commit time.

## `check(tableKey, primaryKey, filter)`

WRITE only. Queues a ConditionCheck; it verifies a condition without modifying the item. The parameter is named `filter` in the implementation, but it composes a **Condition Expression**, not a query Filter Expression. An empty expression is rejected.

```ts
const tx = db.transaction({ mode: DynamoDBTransactionMode.WRITE })
  .check('users', 'user-1', Equal('status', 'active'))
  .createOne('orders', ['user-1', 'order-001'], { status: 'pending' });
await tx.commit();
```

If TTL is configured, the library adds a requirement that the expiry is absent or greater than the transaction's `now`. This method does not independently require item existence; include `AttributeExists` if your chosen condition could be true for a missing item. A failed check cancels the transaction and `commit` rejects.

## `createOne(tableKey, primaryKey, item, opts = {})`

WRITE only. Queues a put. Options accept `ttl?: number` and `onConflict?: 'replace' | 'ignore'`. The default is full replacement. A positive TTL is calculated from the transaction's fixed `now`.

```ts
await db.transaction({ mode: DynamoDBTransactionMode.WRITE })
  .createOne('users', 'user-1', { displayName: 'Alice' }, { onConflict: 'ignore' })
  .createOne('users', 'user-2', { displayName: 'Bob' })
  .commit();
```

Here `onConflict: 'ignore'` queues an absence condition. If a key already exists, the whole transaction fails; it does **not** silently skip that put or return `{ created: false }` as the nontransactional service method does. The commit result does not include previous items or per-item `created` flags.

## `update(tableKey, primaryKey, commands, condition = null, opts = {})`

WRITE only. Queues an Update Expression from `commands: DynamoDBExpression[]` and optionally a Condition Expression. Options accept only `ttl` and `upsert` (default true); there are no per-item returned attributes.

```ts
await db.transaction({ mode: DynamoDBTransactionMode.WRITE })
  .update('users', 'user-1', [Increment('visits', 1)], Equal('status', 'active'), {
    upsert: false,
  })
  .commit();
```

`upsert: false` adds existence and expiry conditions. A failed condition cancels the transaction and makes `commit` reject rather than returning `updatedOrCreated: false`.

Unlike service `update`, the transaction method accepts an empty command array when `ttl` is supplied. Use this only when a configured TTL attribute and a nonnegative TTL will actually generate an update fragment:

```ts
await db.transaction({ mode: DynamoDBTransactionMode.WRITE })
  .update('users', 'user-1', [], null, { ttl: 0, upsert: false })
  .commit();
```

The method copies the command array before adding TTL fragments, preserving the caller's array.

## `deleteOne(tableKey, primaryKey, condition = null)`

WRITE only. Queues a delete with an optional Condition Expression. There is no options or casing argument. TTL does not add an automatic condition. No previous item or per-item `deleted` flag is returned.

```ts
await db.transaction({ mode: DynamoDBTransactionMode.WRITE })
  .deleteOne('orders', ['user-1', 'order-001'], Equal('status', 'cancelled'))
  .commit();
```

A false condition cancels the transaction, including its other writes.

## `commit<T>(casing = 'camel')`

Executes the queued transaction and returns `Promise<DynamoDBTransactionResult<T | null>>`.

| Field | READ | WRITE |
| --- | --- | --- |
| `numberOfTransactItems` | Number of queued reads | Number of queued writes and condition checks |
| `items` | Ordered `(T \| null)[]` | Omitted |

`casing` is `'camel'` or `'snake'`; it applies to top-level attributes in READ results. The transaction queue is cleared after success and on handled request failures. Rebuild operations after failure; an unchanged second commit has an empty queue and is not a replay. For a fresh TTL reference time, create a new transaction.

The conflict retry wrapper retries cancellations whose reasons include `TransactionConflict`. Ordinary conditional cancellations are not retried. A WRITE failure is atomic at the transaction level, but a transport error may leave the caller uncertain about the outcome; the library does not expose a transaction idempotency token or reconcile that outcome.

Handled errors are `DynamoDBError` with the underlying `cause`: exhausted conflicts use status 409; other transaction cancellations use 400; WRITE validation errors use 400; other wrapped errors use 500. READ validation errors currently fall through to status 500.

## Low-level constructor and exposed helpers

These are public in the current source, but application code normally uses `db.transaction` and `commit`.

### `constructor(mode, ddbDocClient, tables, txRetryLimit, txRetryDelay, logger, now, returnConsumedCapacity?)`

Creates a transaction directly. Parameters are a `DynamoDBTransactionMode`, an SDK `DynamoDBDocumentClient`, the configured table map, numeric retry settings, a `DynamoDBLogger`, epoch seconds, and optional SDK `ReturnConsumedCapacity`. An invalid mode throws. The caller manages the supplied client; the transaction has no `destroy` method.

### `txConflictRetryWrapper(command, retries, delay)`

Accepts an SDK `TransactGetCommand` or `TransactWriteCommand` and sends it with conflict retries. For valid finite integer settings, attempts are clamped to 1–10 and delay to at least 50 milliseconds; waiting uses `delay * attemptNumber`. Non-conflict errors are rethrown immediately. It returns the SDK output (the declared type also includes `undefined`), without service result conversion or queue cleanup. Prefer `commit`.

### `_cleanup()`

Returns `void` and clears queued operations and TTL bookkeeping. It makes no database request and cannot undo already committed writes. It is called internally by `commit`; application code should normally create a new transaction rather than manage this bookkeeping.
