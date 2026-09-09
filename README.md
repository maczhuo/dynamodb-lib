# @jzhuo3/dynamodb-lib

A TypeScript DynamoDB document service extracted from the original shared application service. Provides CRUD, batch operations, query pagination, TTL handling, expression builders and transactions. Runs in Node.js 18+ on Lambda, servers, containers, or local processes.

The package name is provisional until the npm scope owner confirms it. This project has not been published.

## Development

Use Node.js 22.12+ and npm 11 for development. The published runtime supports Node.js 18+; Vitest and the build toolchain are development dependencies only.

```sh
npm ci
npm run check
npm run test:coverage
npm run test:integration
```

Vitest provides fast TypeScript unit tests, deterministic SDK mocks, fake timers for retry tests, and V8 coverage. Integration tests use Node's built-in runner so the exact built output can be tested on Node 18 independently of Vitest. No finite suite covers literally every possible input or AWS failure; coverage gates and real protocol tests make regressions visible.

`npm run check` checks source types, unit tests, both builds, archive contents, and TypeScript/JavaScript consumers using both module formats. `npm run test:install` additionally downloads dependencies into a clean temporary consumer and checks the published dependency graph; it requires network access. Coverage output is in `coverage/index.html`.

## Usage

```ts
import DynamoDBService, {
  Assign, Increment, Equal, DynamoDBTransactionMode,
  type DynamoDBConfig, type DynamoDBLogger,
} from '@jzhuo3/dynamodb-lib';

const config: DynamoDBConfig = {
  region: 'us-east-1',
  tables: new Map([
    ['users', {
      name: 'Users',
      partitionKey: 'Id',
      partitionKeyType: 'S',
      timeToLiveAttribute: 'ExpiresAt',
    }],
  ]),
};

// An existing Winston logger satisfies this interface. Omitting it disables logging.
const logger: DynamoDBLogger = {
  debug: (message, ...meta) => console.debug(message, ...meta),
  warn: (message, ...meta) => console.warn(message, ...meta),
  error: (message, ...meta) => console.error(message, ...meta),
};
const db = new DynamoDBService(config, logger);
await db.createOne('users', 'user-1', { displayName: 'Alice', visits: 0 });
const user = await db.getOne<{ id: string; displayName: string }>('users', 'user-1');
await db.update('users', 'user-1', [Increment('visits', 1)], null, { upsert: false });
await db.transaction({ mode: DynamoDBTransactionMode.WRITE })
  .update('users', 'user-1', [Assign('displayName', 'Alex')], Equal('displayName', 'Alice'))
  .commit();
// At application shutdown, not at the end of each Lambda invocation:
db.destroy();
```

CommonJS:

```js
const { DynamoDBService, Equal } = require('@jzhuo3/dynamodb-lib');
```

ESM and CJS both include declarations. Do not mix expression objects created by one module format with a service loaded through the other in the same process: each format has its own class identity.

For Lambda, create the service outside the handler and reuse its connections. Region and credentials default to the AWS SDK provider chain (including the Lambda execution role, environment variables and shared profiles). No Lambda-specific globals or Hono imports are used. Local connections require explicit dummy credentials:

```ts
const db = new DynamoDBService({
  ...config,
  endpoint: 'http://127.0.0.1:8000',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
```

## Configuration and migration

`DynamoDBConfig` exports `tables`, optional `endpoint`, `region`, `credentials`, `maxSockets` (default 50), `requestTimeout` (SDK default), `txRetryLimit` (default 3 attempts), and `txRetryDelay` (default 50 ms). Transaction attempts are clamped to 1–10. Batch unprocessed requests use bounded exponential backoff. SDK transport retries also apply.

`DynamoDBTableDefinition`, `DynamoDBGSIConfig`, `DynamoDBLSIConfig`, operation options/results, `DynamoDBLogger`, and `DynamoDBExpression` are exported. Table definitions describe existing tables; the service does not create production tables automatically.

Replace the old `DynamoDBService.getInstance(honoContext)` with an application-owned `new DynamoDBService(config, logger)`. A Hono application may import `DynamoDBConfig` and `DynamoDBService` as types for its bindings/variables without adding Hono to this library. Errors use `DynamoDBError`, with `status` and the original `cause`, rather than `HTTPException`; map these at the HTTP boundary if needed. Some validation and SDK batch-read errors retain their original error types.

The constructor accepts independent configurations, rather than using one process-wide singleton. No imports of Winston, Hono, date-fns or application aliases remain. Direct runtime dependencies are only `radash` and `@aws-sdk/*`; AWS itself has transitive Smithy and other dependencies. `ucFirst` and `lcFirst` are exported, and epoch seconds use native `Date` arithmetic.

## API conventions

- `getOne<T>(tableKey, primaryKey, options?, casing?)` returns an item or `null`.
- `getMany<T>(tableKey, primaryKeys, options?, casing?)` preserves requested order and fills missing/expired entries with `null`; duplicate keys are rejected.
- `find<T>(tableKey, keyCondition, filter?, options?, casing?)` queries a table or index and returns `{ items, cursor? }`. It is not a table scan. Key conditions may be expressions or tuples such as `['partition']`, `['partition', 'sort']`, `['partition', ['BETWEEN', ['a', 'z']]]`, and `['partition', ['begins_with', 'prefix']]`.
- `createOne`, `createMany`, `update`, `deleteOne`, and `deleteMany` retain the original method signatures. Batch writes are not atomic; transaction writes are atomic. `createMany` replaces existing items. `createOne` defaults to replace and supports `onConflict: 'ignore'`.
- `update` defaults to upsert; set `upsert: false` to require an existing, unexpired item. A conditional failure returns `updatedOrCreated: false`. Delete returns `deleted: false` for a failed condition; otherwise `deleted: true` means DynamoDB accepted the delete, including an already absent item. Use `returnValue: 'ALL_OLD'` to obtain the deleted item.
- Composite keys are `[partitionKey, sortKey]`; scalar keys may be strings, numbers or Buffers. Schema key names use their actual stored spelling.
- Top-level data fields are stored in UpperCamelCase and returned as camelCase by default, or snake_case with the final casing argument. Nested values keep their original field names. This convention is inherited from the source service.
- Attribute paths support nested maps and list indices: `value.accessToken`, `items[0]`. Escape literal nested dots/brackets with a backslash (e.g. `'value.a\\.b'` in JavaScript).
- TTL values are epoch seconds. A positive `ttl` is a duration from now; `update` with `ttl: 0` removes expiry. Expired items are hidden by reads without waiting for DynamoDB's asynchronous deletion. Single and batch reads hide TTL unless requested in projection; transaction reads retain the original projected TTL behavior. Include TTL in index projections when relying on expiry filtering.
- Query options include `projectionFields`, `consistentRead`, `indexToScan`, `ascending`, positive `limit`, `cursor`, and `returnConsumedCapacity`. Pass the returned cursor unchanged; index cursors now include the complete table/index key object. Table cursors retain the original scalar/tuple format. GSIs use eventual consistency.
- Transactions are chainable (`getOne` in READ mode; `check`, `createOne`, `update`, `deleteOne` in WRITE mode), and `commit()` clears queued operations. This initial release preserves the original 25-operation transaction cap. Conflict retries are bounded; conditional cancellations are not retried.

**Condition Expression builders** compose the conditions used by conditional writes. They can also compose query Key Condition Expressions and Filter Expressions where the operator is valid: `Equal`, `NotEqual`, `MoreThan`, `MoreThanOrEqual`, `LessThan`, `LessThanOrEqual`, `Between`, `In`, `AttributeExists`, `AttributeNotExists`, `AttributeType`, `BeginsWith`, `Contains`, `Size`, `And`, `Or`, `Not`.

**Update Expression builders** compose the changes passed to `update` as a command array: `Assign`, `AssignIfNotExists`, `Increment`, `Decrement`, `ListAppend`, `ListPrepend`, `Remove`, `SetAdd`, `SetDelete`.

## Detailed documentation

See the [documentation index](doc/README.md) for [every service method](doc/service.md), [configuration](doc/configuration.md), [Condition Expression and Update Expression builders](doc/expressions.md), [transaction methods](doc/transactions.md), and [examples](doc/examples.md).

## Integration tests

The default target is `http://127.0.0.1:8000`, with dummy credentials and `us-east-1`. Tests create uniquely named tables for string, number and binary keys, plus a composite-key table with a GSI, an LSI and TTL, generate records (including 105-item batches), and delete only those test tables in teardown. Existing tables are not used or modified. If forcibly terminated, remove the printed test table manually.

```sh
npm run test:integration -- --endpoint http://127.0.0.1:8000 --region us-east-1
npm run test:integration -- --aws --profile sandbox --region us-east-1 --table-prefix dynamodb-lib-test
# Equivalent environment configuration:
DYNAMODB_TEST_AWS=1 AWS_PROFILE=sandbox AWS_REGION=us-east-1 npm run test:integration
```

Supported environment variables: `DYNAMODB_ENDPOINT`, `DYNAMODB_TEST_AWS=1`, `DYNAMODB_TABLE_PREFIX`, `AWS_REGION`, `AWS_PROFILE`, and standard AWS credential variables. `--aws` explicitly selects real AWS and clears a supplied endpoint; use a dedicated test account/profile. This mode can incur AWS charges. It needs CreateTable, DescribeTable, UpdateTimeToLive, DeleteTable, GetItem, PutItem, UpdateItem, DeleteItem, Query, BatchGetItem and BatchWriteItem permissions on the temporary table prefix and its indexes; transactional operations need the corresponding item actions, including ConditionCheckItem for checks. No real AWS credentials are needed for localhost.

After building, `node --test tests/integration.test.mjs` runs only integration tests without rebuilding, useful for the Node 18 compatibility matrix.

## Node 18 dependency policy

AWS SDK releases after its Node 18 support cutoff require newer Node versions. This package pins SDK 3.958.0 and bundles its AWS SDK dependencies and ships `npm-shrinkwrap.json` so consumers receive the tested transitive graph. The shrinkwrap includes a patched `fast-xml-parser` (5.7.1) and a Node 18-compatible `@aws-sdk/util-locate-window` (3.953.0). Root-only npm overrides and shrinkwrap alone did not protect downstream consumers in the clean-install test. Bundling the AWS SDK tree preserves the patches and increases the archive size. Radash remains an ordinary dependency. `test:install` verifies the actual archive in a clean npm consumer.

This preserves the requested compatibility but requires deliberate dependency updates and audit checks. Node 18 may print the SDK's end-of-support warning. Use a currently supported Node runtime for new Lambda deployments. Build and test dependencies are not installed for downstream users.

## Publishing preparation

See [PUBLISHING.md](PUBLISHING.md) for package ownership, authentication, licensing and release steps. No credentials belong in this repository.
