# Condition Expression and Update Expression builders

[Documentation index](README.md) · [Service reference](service.md) · [Transaction reference](transactions.md)

All functions below are named exports from `@jzhuo3/dynamodb-lib`. Each returns a `DynamoDBExpression`; calling a builder does not send a request. Attribute paths are converted to name placeholders and values are stored separately as value placeholders.

## Expression contexts

| Context | Purpose | Where to pass it |
| --- | --- | --- |
| **Condition Expression** | Decides whether a write may proceed | `db.update(..., commands, condition)`, `db.deleteOne(..., condition)`, transaction `check`, `update` and `deleteOne` |
| **Key Condition Expression** | Selects a partition and optional sort-key range | `db.find(tableKey, keyCondition, ...)` |
| **Filter Expression** | Filters items selected by the query | `db.find(tableKey, keyCondition, filter, ...)` |
| **Update Expression** | Specifies item changes | The `commands` array in service or transaction `update` |

A write's Condition Expression must be true for that write to succeed. It does not describe the modifications; the Update Expression does that. See [AWS Condition Expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ConditionExpressions.html).

Key conditions require partition-key equality. An optional sort-key condition supports `=`, `<`, `<=`, `>`, `>=`, `BETWEEN` or `begins_with`; arbitrary non-key comparisons, `In`, `Or` and `Not` do not belong there. The library's common expression type does not enforce these context restrictions. See [AWS Key Condition Expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.KeyConditionExpressions.html).

```ts
import { And, Equal, MoreThanOrEqual, Assign, Increment } from '@jzhuo3/dynamodb-lib';

const condition = And(Equal('status', 'active'), MoreThanOrEqual('credits', 10));
const commands = [Assign('lastAction', 'purchase'), Increment('purchases', 1)];
// await db.update('users', 'user-1', commands, condition, { upsert: false });
```

## Condition Expression builders

`attribute` is always a string attribute path. `value`, bounds and operands are native JavaScript values compatible with the stored attribute type. The comparison helpers are generic in their value type; they do not validate the stored schema.

| Builder signature | Condition composed | Example |
| --- | --- | --- |
| `Equal<T>(attribute, value)` | Equality | `Equal('status', 'active')` |
| `NotEqual<T>(attribute, value)` | Inequality (`<>`) | `NotEqual('status', 'archived')` |
| `MoreThan<T>(attribute, value)` | Greater than | `MoreThan('credits', 0)` |
| `MoreThanOrEqual<T>(attribute, value)` | Greater than or equal | `MoreThanOrEqual('credits', 10)` |
| `LessThan<T>(attribute, value)` | Less than | `LessThan('attempts', 5)` |
| `LessThanOrEqual<T>(attribute, value)` | Less than or equal | `LessThanOrEqual('attempts', 5)` |
| `Between<T>(attribute, lowerBound, upperBound)` | Inclusive range | `Between('score', 10, 20)` |
| `In<T>(attribute, values: T[])` | Value matches an entry in the supplied list | `In('status', ['draft', 'pending'])` |
| `AttributeExists(attribute)` | Attribute is present | `AttributeExists('email')` |
| `AttributeNotExists(attribute)` | Attribute is absent | `AttributeNotExists('deletedAt')` |
| `AttributeType(attribute, valueType)` | Attribute has the specified DynamoDB type | `AttributeType('tags', 'SS')` |
| `BeginsWith(attribute, prefix: string)` | String prefix matches | `BeginsWith('orderId', '2026-')` |
| `Contains<T>(attribute, operand)` | String contains a substring, or collection contains an element | `Contains('tags', 'premium')` |
| `Size(attribute, operator, value: number)` | Compares the attribute's size | `Size('displayName', '>=', 3)` |
| `And(...expressions)` | All supplied conditions must hold | `And(Equal('status', 'active'), AttributeExists('email'))` |
| `Or(...expressions)` | At least one supplied condition must hold | `Or(Equal('role', 'admin'), Equal('role', 'editor'))` |
| `Not(expression)` | Negates a condition | `Not(Contains('tags', 'blocked'))` |

### Arguments and validation

- `Between` rejects numeric bounds when the lower bound is greater than the upper bound. Equal bounds are accepted. The implementation does not check ordering for other value types.
- `In` requires 1–100 values. This checks the attribute against a list of alternatives; it does not check membership inside a stored list. Use `Contains` for that.
- `AttributeType` accepts `'S'`, `'N'`, `'B'`, `'SS'`, `'NS'`, `'BS'`, `'BOOL'`, `'NULL'`, `'L'` or `'M'`.
- `Size` accepts `=`, `<>`, `<`, `<=`, `>` or `>=`. The operator is a required argument.
- `And` and `Or` each require at least one expression. They combine placeholder maps and group child expressions where needed. `Not` takes exactly one expression.
- Use compatible DynamoDB types for each operator. A builder producing an expression does not guarantee DynamoDB will accept that expression in every context.

```ts
import { And, Or, Not, Equal, AttributeExists, Contains } from '@jzhuo3/dynamodb-lib';

const allowed = And(
  AttributeExists('email'),
  Or(Equal('role', 'admin'), Equal('role', 'editor')),
  Not(Contains('tags', 'blocked')),
);
// await db.deleteOne('users', 'user-1', allowed);
```

## Update Expression builders

Pass these as an array to `update`. The service groups their fragments into one Update Expression. Do not combine them with `And` or `Or`, which compose conditions.

| Builder signature | Clause | Behavior and example |
| --- | --- | --- |
| `Assign(attribute, value)` | `SET` | Sets/replaces a value: `Assign('displayName', 'Alice')` |
| `AssignIfNotExists(attribute, value)` | `SET` | Sets a value only if the attribute is absent: `AssignIfNotExists('preferences', {})` |
| `Increment(attribute, value: number)` | `ADD` | Adds a number: `Increment('visits', 1)` |
| `Decrement(attribute, value: number)` | `ADD` | Adds the negated number: `Decrement('credits', 10)` |
| `ListAppend(attribute, value: any[], upsert = false)` | `SET` | Appends list elements: `ListAppend('events', ['login'], true)` |
| `ListPrepend(attribute, value: any[], upsert = false)` | `SET` | Prepends list elements: `ListPrepend('events', ['start'], true)` |
| `Remove(attribute)` | `REMOVE` | Removes an attribute or list position: `Remove('temporaryCode')` |
| `SetAdd(attribute, value: Set<any>)` | `ADD` | Adds set members: `SetAdd('tags', new Set(['premium']))` |
| `SetDelete(attribute, value: Set<any>)` | `DELETE` | Removes set members: `SetDelete('tags', new Set(['trial']))` |

### Arguments and behavior

`Increment` and `Decrement` reject non-finite numbers, including `NaN` and infinity. Negative increments subtract; negative decrements add. These helpers use DynamoDB's `ADD` clause, which applies to top-level attributes. `SetAdd` and `SetDelete` require nonempty JavaScript Sets. Use homogeneous string, number or binary members compatible with the stored set.

Both list helpers require arrays. Their `upsert` flag initializes a missing list to `[]` before appending/prepending. It does not control whether the item itself may be created; the service's `opts.upsert` controls that separately.

Nested assignments require existing parent maps. Avoid overlapping paths in one update, such as assigning `value` while also assigning `value.accessToken`. `SetDelete` removes set members, whereas `Remove` removes the attribute. These restrictions and clause semantics come from [AWS Update Expressions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html).

```ts
import { Assign, Increment, ListAppend, Remove, SetAdd } from '@jzhuo3/dynamodb-lib';

const commands = [
  Assign('displayName', 'Alex'),
  Increment('visits', 1),
  ListAppend('events', ['profile-update'], true),
  SetAdd('tags', new Set(['verified'])),
  Remove('temporaryCode'),
];
// await db.update('users', 'user-1', commands, null, {
//   upsert: false, returnValue: 'ALL_NEW',
// });
```

## Attribute paths and escaping

Top-level names are normalized to UpperCamelCase; nested names preserve their spelling.

| JavaScript argument | Stored path addressed |
| --- | --- |
| `'display_name'` | `DisplayName` |
| `'value.accessToken'` | `Value.accessToken` |
| `'items[0]'` | First element of `Items` |
| `'value.a\\.b'` | The literal key `a.b` inside `Value` |
| `'value.a\\[0\\]'` | The literal key `a[0]` inside `Value` |

The two backslashes in JavaScript source produce one escape character in the actual string. Empty attribute path segments are rejected. These examples assume parent maps/lists already exist where required.

## `DynamoDBExpression`

```ts
new DynamoDBExpression(
  expressionAttributeNameMap = new Map<string, string>(),
  expressionAttributeValueMap = null,
  expression = '',
  updateExpressionGroup?,
);
```

This is the low-level container shared by all builders:

| Public property | Type / purpose |
| --- | --- |
| `expressionAttributeNameMap` | `Map<string, string>` mapping name placeholders to stored names |
| `expressionAttributeValueMap` | `Map<string, any> \| null` mapping value placeholders to native values |
| `expression` | Expression fragment string |
| `updateExpressionGroup` | Optional `SET`, `REMOVE`, `ADD` or `DELETE`; required for update fragments |

Prefer the builders. When constructing fragments manually, follow their `#attr...` and `:val...` placeholder conventions so composition can rename placeholders correctly. Merely constructing this class does not validate the expression. Its maps are public and mutable; avoid editing them after passing the expression into a transaction.
