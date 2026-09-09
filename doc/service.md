# DynamoDBService method reference

[Documentation index](README.md) · [Configuration](configuration.md) · [Examples](examples.md)

The signatures below use the documentation aliases `PrimaryKey` and `Casing` from [shared conventions](configuration.md#keys-data-and-return-types). All operation methods are asynchronous except `transaction` and `destroy`. Snippets assume the `db` and tables defined in [configuration](configuration.md).

## `constructor(options, logger?)`

Creates an independent service and its SDK clients. `options` is `DynamoDBConfig`; `logger` is an optional `DynamoDBLogger`. It validates basic table configuration, but does not create tables or verify their existence. Reuse the instance across requests.

```ts
const db = new DynamoDBService(config, logger);
```

## `getOne<T>(tableKey, primaryKey, opts?, casing?)`

Returns `Promise<T | null>`. A missing or expired item produces `null`.

| Argument | Meaning |
| --- | --- |
| `tableKey: string` | Configured table alias |
| `primaryKey: PrimaryKey` | Full primary key |
| `opts` | `consistentRead` (false), `projectionFields`, `returnConsumedCapacity` (NONE) |
| `casing: Casing` | Defaults to `camel` |

```ts
const user = await db.getOne<{ id: string; displayName: string }>(
  'users', 'user-1', { consistentRead: true, projectionFields: ['Id', 'DisplayName'] },
);
```

`projectionFields` controls which fields are returned. The TTL field is fetched automatically when needed for expiry checks and removed unless requested. `cursor`, `limit`, `ascending` and `indexToScan` are not accepted by this method.

## `getMany<T>(tableKey, primaryKeys, opts?, casing?)`

Returns `Promise<(T | null)[]>` in the same order as `primaryKeys`, even if DynamoDB returns items in a different order. Missing or expired positions are `null`. Options and casing are the same as `getOne`.

```ts
const users = await db.getMany<{ displayName: string }>(
  'users', ['user-1', 'missing-user', 'user-2'],
  { consistentRead: true, projectionFields: ['DisplayName'] },
);
// The second position is null if missing-user does not exist.
```

An empty key array returns `[]`. Duplicate keys are rejected. Requests are split into groups of at most 100 keys. Unprocessed keys are retried with bounded backoff; exhaustion throws. Automatically fetched key fields are removed when omitted from the requested projection. Multiple requests are not one atomic snapshot.

## `find<T>(tableKey, keyCondition, filter = null, opts = {}, casing = 'camel')`

Returns `Promise<DynamoDBFindResult<T>>`, containing `items: T[]` and an optional `cursor`. This method performs a query on one table or index.

`keyCondition` may be a `DynamoDBExpression` or one of these tuple forms:

| Form | Meaning |
| --- | --- |
| `['user-1']` | Partition-key equality |
| `['user-1', 'order-001']` | Partition- and sort-key equality |
| `['user-1', ['BETWEEN', ['order-001', 'order-099']]]` | Partition equality and inclusive sort-key range |
| `['user-1', ['begins_with', 'order-']]` | Partition equality and sort-key prefix |

For an index, tuple values refer to that index's keys. The current LSI tuple form requires both a partition and sort-key condition. To express other supported sort-key comparisons, build a Key Condition Expression, for example `And(Equal('userId', 'user-1'), MoreThan('orderId', 'order-001'))`.

`filter` is an optional Filter Expression composed with the [Condition Expression builders](expressions.md). It filters queried items; it does not select a different partition. Key conditions have a narrower set of allowed operators than general conditions; see [expression contexts](expressions.md#expression-contexts).

| Option | Default | Meaning |
| --- | --- | --- |
| `consistentRead` | `false` | Strong reads for a table or LSI; forced false for a GSI |
| `projectionFields` | All fields, except hidden TTL | Requested attribute paths |
| `indexToScan` | None | Configured index name; despite its name, this selects a Query index |
| `limit` | No item limit | Positive integer count of returned items after filtering/TTL handling |
| `ascending` | `true` | Sort-key order |
| `cursor` | None | Cursor returned by the previous call |
| `returnConsumedCapacity` | `NONE` | Forwarded SDK capacity setting |

```ts
const first = await db.find<{ userId: string; orderId: string }>(
  'orders', ['user-1'], null, { limit: 20, ascending: false },
);
if (first.cursor !== undefined) {
  const next = await db.find('orders', ['user-1'], null, {
    limit: 20, ascending: false, cursor: first.cursor,
  });
}
```

Pass the cursor unchanged with the same query/index/filter/order. Test for `undefined`, since a valid numeric key can be zero. Table cursors are scalar or two-value tuples; index cursors contain the full table/index key object. Keep Buffers intact if transporting binary cursors.

The method can make multiple SDK requests, including after an empty filtered page. Without `limit`, it accumulates all matching items in memory. A GSI projection must contain the requested fields; the library rejects incompatible explicit projections. LSI projection mismatches are logged as warnings.

## `createOne(tableKey, primaryKey, item, opts?, casing?)`

Returns `Promise<DynamoDBCreateOneResult>`. `item` is `Record<string, any>`; `opts` is `DynamoDBCreateOptions`.

| Option | Default | Meaning |
| --- | --- | --- |
| `onConflict` | `replace` | Replace the entire existing item, or `ignore` if the key already exists |
| `ttl` | None | Positive expiry duration in seconds |
| `returnConsumedCapacity` | `NONE` | Forwarded SDK setting |

| Result field | Meaning |
| --- | --- |
| `created` | True for a new item or replacement of an expired item; false for replacement of a live item or an ignored conflict |
| `replacedItem` | Previous live item for replacement mode, converted using `casing` and with TTL removed |
| `expiresAt` | Epoch seconds when a positive TTL was successfully set |

```ts
const result = await db.createOne('users', 'user-1', {
  displayName: 'Alice', visits: 0,
}, { onConflict: 'ignore', ttl: 3600 });
```

Replacement is a full put, not a merge. An ignored conflict returns `{ created: false }` rather than throwing. An expired row can still block `ignore` until it is physically deleted. Arbitrary Condition Expressions are not accepted here; use the supported conflict option or a conditional update when appropriate.

## `createMany(tableKey, primaryKeys, items, opts?)`

Returns `Promise<DynamoDBCreateManyResult>` with `numberOfItems` and optional `expiresAt`. `primaryKeys: PrimaryKey[]` and `items: Record<string, any>[]` are paired by array position. Both must be nonempty and have equal lengths.

Options are `ttl` and `returnConsumedCapacity`; there is no conflict policy or casing argument. Existing items are replaced.

```ts
await db.createMany('users', ['user-1', 'user-2'], [
  { displayName: 'Alice' }, { displayName: 'Bob' },
], { ttl: 3600 });
```

The method splits writes into batches of at most 25 and retries unprocessed items. The operation is not atomic; earlier writes may have succeeded if a later request fails. `numberOfItems` is the submitted item count, not a count of newly inserted keys. Use distinct keys.

## `update<T>(tableKey, primaryKey, commands, condition = null, opts = {}, casing = 'camel')`

Returns `Promise<DynamoDBUpdateResult<T>>`. `commands` is a nonempty array of **Update Expression builders**. `condition` is an optional **Condition Expression** controlling whether the update may proceed.

| Option | Default | Meaning |
| --- | --- | --- |
| `upsert` | `true` | False requires an existing, unexpired item |
| `ttl` | Unchanged | Positive seconds set expiry; zero removes expiry |
| `returnValue` | `NONE` | `NONE`, `ALL_OLD`, `UPDATED_OLD`, `ALL_NEW` or `UPDATED_NEW` |
| `returnConsumedCapacity` | `NONE` | Forwarded SDK setting |

```ts
const result = await db.update<{ visits: number }>(
  'users', 'user-1',
  [Increment('visits', 1), Assign('displayName', 'Alex')],
  Equal('displayName', 'Alice'),
  { upsert: false, returnValue: 'ALL_NEW' },
);
if (result.updatedOrCreated) console.log(result.item);
```

`updatedOrCreated` is true after an accepted update; it does not distinguish insertion from modification. A failed condition returns false rather than throwing. `item?: Partial<T>` is present when attributes were returned; `expiresAt` is present when a positive TTL was successfully set. Commands are copied before library-added TTL changes.

With `upsert: false`, the library combines your condition with existence and expiry checks. A TTL-only service update still requires at least one explicit command; transaction `update` has different validation, described in its reference. Update and condition builders cannot be interchanged.

## `deleteOne<T>(tableKey, primaryKey, condition = null, opts = {}, casing = 'camel')`

Returns `Promise<DynamoDBDeleteOneResult<T>>`: `deleted: boolean`, plus optional `item: T`. Options are `returnValue` (`NONE` or `ALL_OLD`, default `NONE`) and `returnConsumedCapacity`.

```ts
const result = await db.deleteOne<{ displayName: string }>(
  'users', 'user-1', Equal('displayName', 'Alice'), { returnValue: 'ALL_OLD' },
);
```

`deleted: true` means the request succeeded, even if no item previously existed. A failed condition returns false. Request `ALL_OLD` to retrieve the previous item; it is absent if no item existed. TTL does not automatically prevent a delete, and returned attributes can include the TTL field.

## `deleteMany(tableKey, primaryKeys, opts?)`

Returns `Promise<DynamoDBDeleteManyResult>` with `numberOfItems`, the number of submitted keys, not a count of previously existing records. Options accept only `returnConsumedCapacity`.

```ts
await db.deleteMany('users', ['user-1', 'user-2']);
```

An empty array returns `{ numberOfItems: 0 }`. Requests use batches of at most 25 and retry unprocessed deletions. There are no per-item conditions or returned items. Partial completion is possible if a request ultimately fails. Use distinct keys.

## `transaction(opts)`

Creates a `DynamoDBTransaction` without sending requests. `opts: DynamoDBTransactionOptions` requires `mode` (`DynamoDBTransactionMode.READ` or `.WRITE`), and optionally accepts `now` (epoch seconds) and `returnConsumedCapacity` (default `NONE`). `now` defaults to the time the transaction object is created.

```ts
const tx = db.transaction({ mode: DynamoDBTransactionMode.READ });
const result = await tx.getOne('users', 'user-1').commit();
```

See [all transaction methods](transactions.md) for queueing, results, expiry and failure behavior.

## `destroy()`

Returns `void` and destroys the underlying SDK client connections. Call it when the application is finished with the service; create a new service if needed afterward.

```ts
db.destroy();
```

In Lambda, keep the service outside the handler and reuse it across invocations. Calling `destroy` at the end of every handler invocation prevents connection reuse.
