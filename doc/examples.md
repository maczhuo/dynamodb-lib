# Examples

[Documentation index](README.md) · [Complete TypeScript walkthrough](examples.ts)

The walkthrough uses an existing `Users` table (`Id`, string partition key) and `Orders` table (`UserId` + `OrderId`, string composite key). `Users` declares `ExpiresAt` as its TTL attribute. Importing the example does nothing; calling `runExamples(db)` creates, updates and deletes its `doc-*` example IDs. Use tables dedicated to examples. The example's final cleanup is ordinary application code, not a failure-safe test fixture.

Each snippet below assumes a configured `db` as shown in [configuration](configuration.md). Imports are included for the expression helpers it uses.

## Create without replacing a stored item

```ts
const created = await db.createOne('users', 'user-1', {
  displayName: 'Alice', status: 'active', credits: 100,
}, { onConflict: 'ignore' });
console.log(created.created);
```

If that key already exists, this returns false. For transaction creates, the same option instead causes the whole transaction to reject on conflict.

## Compose a Condition Expression and an Update Expression

```ts
import { And, Equal, MoreThanOrEqual, Decrement, Assign } from '@jzhuo3/dynamodb-lib';

const condition = And(
  Equal('status', 'active'),
  MoreThanOrEqual('credits', 10),
);
const commands = [Decrement('credits', 10), Assign('lastAction', 'purchase')];

const result = await db.update('users', 'user-1', commands, condition, {
  upsert: false, returnValue: 'ALL_NEW',
});
if (!result.updatedOrCreated) {
  console.log('The user was missing, expired, inactive, or had insufficient credits.');
}
```

The condition controls whether the write is allowed. The commands describe what changes. A conditional failure is a normal false result for this service method.

## Query a partition with a Filter Expression

```ts
import { Equal } from '@jzhuo3/dynamodb-lib';

const result = await db.find('orders', ['user-1'], Equal('status', 'pending'), {
  limit: 20, ascending: false,
});
console.log(result.items, result.cursor);
```

The tuple composes partition-key equality. `Equal('status', 'pending')` is passed as a Filter Expression because it is the third argument to `find`.

## Read every page

```ts
import type { DynamoDBFindResult } from '@jzhuo3/dynamodb-lib';

type Order = { userId: string; orderId: string; status: string };
let cursor: DynamoDBFindResult<Order>['cursor'];
do {
  const page = await db.find<Order>('orders', ['user-1'], null, { limit: 25, cursor });
  for (const order of page.items) console.log(order.orderId);
  cursor = page.cursor;
} while (cursor !== undefined);
```

Keep query parameters unchanged between pages and pass the cursor as returned. A missing cursor means the library has reached the end.

## Query a configured GSI

If the `orders` table has the `ByStatus` GSI from [configuration](configuration.md#table-and-index-definitions), with stored keys `Status` and `CreatedAt`:

```ts
const pending = await db.find('orders', ['pending'], null, {
  indexToScan: 'ByStatus', ascending: false, limit: 10,
});
```

Here the tuple value is the index partition key. This example requires that index to be provisioned and configured; the base walkthrough does not create one.

## Update nested fields and initialize a list

```ts
import { Assign, ListAppend } from '@jzhuo3/dynamodb-lib';

// Assume Value already contains a map, e.g. { accessToken: 'old' }.
await db.update('users', 'user-1', [
  Assign('value.accessToken', 'replacement'),
  ListAppend('events', ['token-refreshed'], true),
], null, { upsert: false });
```

`true` initializes a missing `events` list. The service's `upsert: false` separately requires an existing item.

## Set or remove expiry

```ts
import { Assign } from '@jzhuo3/dynamodb-lib';

await db.update('users', 'user-1', [Assign('status', 'active')], null, { ttl: 3600 });
await db.update('users', 'user-1', [Assign('status', 'active')], null, { ttl: 0 });
```

A configured TTL field is required. Use seconds, not milliseconds. Service `update` requires a nonempty explicit command array even when changing TTL.

## Write atomically across two items

```ts
import { Equal, Assign, DynamoDBTransactionMode } from '@jzhuo3/dynamodb-lib';

await db.transaction({ mode: DynamoDBTransactionMode.WRITE })
  .check('users', 'user-1', Equal('status', 'active'))
  .update('orders', ['user-1', 'order-001'], [Assign('status', 'paid')],
    Equal('status', 'pending'), { upsert: false })
  .commit();
```

Both conditions must hold. If either fails, `commit` rejects and the order is not updated. The check and update target different items. To check the same item being updated, put the condition on that update.

## Read transaction results

```ts
import { DynamoDBTransactionMode } from '@jzhuo3/dynamodb-lib';

const result = await db.transaction({ mode: DynamoDBTransactionMode.READ })
  .getOne('users', 'user-1', { projectionFields: ['DisplayName'] })
  .getOne('users', 'user-2', { projectionFields: ['DisplayName'] })
  .commit<{ displayName: string }>();
console.log(result.items); // Ordered items, or null at missing/expired positions.
```

For all batch and delete signatures, see the [service reference](service.md). For every helper, including set operations and logical composition, see the [expression reference](expressions.md).
