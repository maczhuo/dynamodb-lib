import DynamoDBService, {
  And, Assign, Decrement, Equal, Increment, ListAppend, MoreThanOrEqual,
  DynamoDBTransactionMode, type DynamoDBConfig, type DynamoDBFindResult,
} from '@jzhuo3/dynamodb-lib';

export interface User {
  id: string;
  displayName: string;
  status: string;
  credits: number;
  visits: number;
}
export interface Order {
  userId: string;
  orderId: string;
  status: string;
  total: number;
}

// These tables must already exist. This configuration does not create tables.
export const localConfig: DynamoDBConfig = {
  endpoint: 'http://127.0.0.1:8000',
  region: 'us-east-1',
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

// Calling this function writes and deletes the example IDs in the supplied tables.
// Merely importing this module performs no operations.
export async function runExamples(db: DynamoDBService): Promise<void> {
  await db.createOne('users', 'doc-user-1', {
    displayName: 'Alice', status: 'active', credits: 100, visits: 0,
    value: { accessToken: 'example-token' },
  }, { onConflict: 'ignore' });

  const user = await db.getOne<User>('users', 'doc-user-1', { consistentRead: true });
  console.log(user);

  const updated = await db.update<User>('users', 'doc-user-1', [
    Decrement('credits', 10), Increment('visits', 1),
    ListAppend('events', ['purchase'], true),
  ], And(Equal('status', 'active'), MoreThanOrEqual('credits', 10)), {
    upsert: false, returnValue: 'ALL_NEW',
  });
  console.log(updated.updatedOrCreated, updated.item);

  // The parent map Value was created with the item above.
  await db.update('users', 'doc-user-1', [Assign('value.accessToken', 'new-token')]);
  await db.update('users', 'doc-user-1', [Assign('status', 'active')], null, { ttl: 3600 });
  await db.update('users', 'doc-user-1', [Assign('status', 'active')], null, { ttl: 0 });

  const orderKeys: [string, string][] = [
    ['doc-user-1', 'doc-order-001'], ['doc-user-1', 'doc-order-002'],
  ];
  await db.createMany('orders', orderKeys, [
    { status: 'pending', total: 10 }, { status: 'pending', total: 20 },
  ]);
  console.log(await db.getMany<Order>('orders', orderKeys, { consistentRead: true }));

  let cursor: DynamoDBFindResult<Order>['cursor'];
  do {
    const page = await db.find<Order>(
      'orders', ['doc-user-1', ['begins_with', 'doc-order-']],
      Equal('status', 'pending'), { limit: 1, cursor, consistentRead: true },
    );
    console.log(page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);

  // Different target items: one condition check and one update.
  await db.transaction({ mode: DynamoDBTransactionMode.WRITE })
    .check('users', 'doc-user-1', Equal('status', 'active'))
    .update('orders', orderKeys[0], [Assign('status', 'paid')], Equal('status', 'pending'))
    .commit();

  console.log(await db.transaction({ mode: DynamoDBTransactionMode.READ })
    .getOne('orders', orderKeys[0])
    .getOne('orders', orderKeys[1])
    .commit<Order>());

  await db.deleteOne('orders', orderKeys[0], Equal('status', 'paid'), { returnValue: 'ALL_OLD' });
  await db.deleteMany('orders', orderKeys);
  await db.deleteOne('users', 'doc-user-1');
}

// Application-owned lifecycle, if you choose to run the walkthrough:
// const db = new DynamoDBService(localConfig);
// try { await runExamples(db); } finally { db.destroy(); }
