# DynamoDB library documentation

Start with [configuration](configuration.md), then use the method references below. These documents describe the current implementation in [src/index.ts](../src/index.ts).

| Document | Contents |
| --- | --- |
| [Configuration and shared conventions](configuration.md) | Table definitions, logger injection, keys, casing, TTL and errors |
| [DynamoDBService methods](service.md) | Constructor, reads, queries, writes, batches, transactions and shutdown |
| [Condition Expression and Update Expression builders](expressions.md) | Every expression helper, its parameters and examples |
| [Transaction methods](transactions.md) | READ/WRITE modes, queueing, commit, retries and conditional failures |
| [Examples](examples.md) | Creating items, conditional updates, pagination, TTL and atomic writes |
| [Complete TypeScript example](examples.ts) | A typed walkthrough using existing tables; importing it does not execute writes |

## What the expression builders compose

**Condition Expression builders** such as `Equal`, `AttributeExists` and `And` describe a condition that must be true for a write to proceed. Pass them to the `condition` argument of `update` or `deleteOne`, or to transaction methods. They return `DynamoDBExpression` objects; they do not execute database operations.

The same comparison and logical builders can compose a query's **Key Condition Expression** or **Filter Expression**, subject to the restrictions of that expression context.

**Update Expression builders** such as `Assign`, `Increment` and `Remove` describe changes to an item. Pass an array of them to `update` or transaction `update`. The library combines them into the `SET`, `REMOVE`, `ADD` and `DELETE` clauses of one Update Expression.

```ts
import { And, Equal, MoreThanOrEqual, Decrement, Assign } from '@jzhuo3/dynamodb-lib';

// Condition Expression: allow the change only for an active item with stock.
const condition = And(Equal('status', 'active'), MoreThanOrEqual('stock', 1));

// Update Expression: decrease stock and record who reserved it.
const commands = [Decrement('stock', 1), Assign('reservedBy', 'user-1')];

// With a configured db and an existing products table:
// await db.update('products', 'product-1', commands, condition, { upsert: false });
```

Use [the expression reference](expressions.md) to distinguish which builders belong in each argument.
