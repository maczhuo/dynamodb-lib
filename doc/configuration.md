# Configuration and shared conventions

[Documentation index](README.md) · [Service reference](service.md)

## `DynamoDBConfig`

```ts
import DynamoDBService, { type DynamoDBConfig } from '@jzhuo3/dynamodb-lib';

const config: DynamoDBConfig = {
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:8000',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  tables: new Map([
    ['users', {
      name: 'Users', partitionKey: 'Id', partitionKeyType: 'S',
      timeToLiveAttribute: 'ExpiresAt',
    }],
    ['orders', {
      name: 'Orders', partitionKey: 'UserId', partitionKeyType: 'S',
      sortKey: 'OrderId', sortKeyType: 'S',
    }],
  ]),
};
const db = new DynamoDBService(config);
```

The example connects to existing local tables. Defining a table here does not create it. The map key (`users`) is the application's alias; `name` (`Users`) is the DynamoDB table name. For AWS, omit the local endpoint and dummy credentials, and use the SDK credential provider chain.

| Field | Type | Default / behavior |
| --- | --- | --- |
| `tables` | `Map<string, DynamoDBTableDefinition>` | Required, nonempty; empty table names are rejected |
| `region` | `DynamoDBClientConfig['region']` | SDK resolution when omitted |
| `credentials` | `DynamoDBClientConfig['credentials']` | SDK credential provider chain when omitted |
| `endpoint` | `string` | SDK service endpoint when omitted |
| `maxSockets` | `number` | `50`; configures the HTTPS keep-alive agent |
| `requestTimeout` | `number` | Milliseconds; omitted value uses the SDK HTTP handler default |
| `txRetryLimit` | `number` | `3` total attempts, clamped to 1–10 by the transaction retry wrapper; supply a finite integer |
| `txRetryDelay` | `number` | `50` milliseconds; minimum 50, multiplied by attempt number between conflict retries |

The SDK's own retry policy also applies. The two `txRetry*` settings apply to transaction conflicts, not batch unprocessed-item retries.

## Table and index definitions

| `DynamoDBTableDefinition` field | Meaning |
| --- | --- |
| `name` | Actual DynamoDB table name |
| `partitionKey`, `partitionKeyType` | Stored key name and scalar type: `'S'`, `'N'` or `'B'` |
| `sortKey`, `sortKeyType` | Optional stored sort-key name and scalar type |
| `nonKeyAttributeDefinitions` | Optional `{ name, type }[]` schema metadata; the service does not provision or validate attributes from it |
| `localSecondaryIndexes` | Optional `DynamoDBLSIConfig[]` |
| `globalSecondaryIndexes` | Optional `DynamoDBGSIConfig[]` |
| `timeToLiveAttribute` | Optional stored TTL field name, e.g. `ExpiresAt` |

Each GSI definition contains `indexName`, `partitionKey`, optional `sortKey`, `projectionType` (`ALL`, `KEYS_ONLY`, `INCLUDE`), and optional `nonKeyAttributes`. Each LSI definition has the same fields except that its partition key comes from the table and its `sortKey` is required. Provide `nonKeyAttributes` for an `INCLUDE` projection. Definitions must match existing indexes.

```ts
const indexDefinition = {
  indexName: 'ByStatus',
  partitionKey: 'Status',
  sortKey: 'CreatedAt',
  projectionType: 'ALL' as const,
};
// Place this in the table's globalSecondaryIndexes array.
```

## Injecting a logger

`DynamoDBLogger` is a structural interface compatible with Winston-style formatted messages and metadata:

```ts
import type { DynamoDBLogger } from '@jzhuo3/dynamodb-lib';

const logger: DynamoDBLogger = {
  debug(message, ...meta) { console.debug(message, ...meta); },
  warn(message, ...meta) { console.warn(message, ...meta); },
  error(message, ...meta) { console.error(message, ...meta); },
};
// new DynamoDBService(config, logger);
// An existing Winston logger can be passed directly instead.
```

All three methods are required and may return any value. Omit the logger for silent operation. Messages may contain item data and expression values; configure the injected logger appropriately for your application.

## Keys, data and return types

Method signatures in these documents use these shorthand types; they are documentation aliases, not package exports:

```ts
type KeyValue = string | number | Buffer;
type PrimaryKey = KeyValue | [KeyValue, KeyValue];
type Casing = 'camel' | 'snake';
```

For a simple-key table, pass `'user-1'`, `42`, or a `Buffer`, according to the schema. For a composite-key table, pass `[partitionValue, sortValue]`. Key arguments override key fields in data supplied to create methods.

Top-level input fields are converted to UpperCamelCase before storing: `display_name` or `displayName` becomes `DisplayName`. Returned fields default to camelCase; pass `'snake'` as the last casing argument for snake_case. Nested values retain their original spelling. Use stored UpperCamelCase schema names to match this convention. `T` is a TypeScript assertion about returned data, not runtime schema validation.

Use native JavaScript values, including `Set` for DynamoDB sets, rather than low-level `{ S: 'value' }` attribute wrappers. The service uses the document client's default marshalling options.

## TTL behavior

`ttl` is a duration in seconds, not an absolute timestamp. It is applied only when `timeToLiveAttribute` is configured. A positive value stores `floor(Date.now() / 1000) + ttl`; transaction writes use the transaction's fixed `now` instead. In update methods, `ttl: 0` removes the field; omitting `ttl` leaves it unchanged. Supply nonnegative integer durations. Negative values are not applied by the implementation.

Reads exclude items whose stored expiry is at or before their reference time. `getOne`, `getMany` and `find` hide the TTL field unless it is explicitly included in `projectionFields`. Transaction reads keep it, including when automatically added to a projection. Returned update and delete attributes do not follow exactly the same TTL-hiding rules: an update strips the field when setting a positive TTL, and deletes return it if DynamoDB returns it.

`onConflict: 'ignore'` checks physical key existence. An expired row that is still stored can therefore prevent a create. `update` with `upsert: false` also checks that an item is unexpired. Delete methods do not automatically add an expiry condition. TTL filtering through an index requires the TTL field to be available in that index's projection.

## Errors and capacity options

`DynamoDBError` extends `Error` and exposes `status` and `cause`. It has no Hono or HTTP response dependency. The status values used by the service are 400 for selected validation/cancellation errors, 409 for exhausted transaction conflicts, and 500 for other wrapped failures. Local validation errors and SDK failures from `getMany` may be ordinary errors; not every failure is wrapped.

```ts
import { DynamoDBError } from '@jzhuo3/dynamodb-lib';

function report(error: unknown) {
  if (error instanceof DynamoDBError) {
    console.error(error.status, error.message, error.cause);
  } else {
    console.error(error);
  }
}
```

`returnConsumedCapacity` accepts the SDK values `NONE`, `TOTAL` or `INDEXES` and defaults to `NONE`. It is forwarded to DynamoDB, but the current service result objects do not expose the returned consumption metrics.

The exported `ucFirst(value: string)` and `lcFirst(value: string)` change only the first character; empty strings remain empty. They are not full camelCase/snake_case converters.
