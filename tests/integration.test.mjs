import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand, UpdateTimeToLiveCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import DynamoDBService, { Assign, AssignIfNotExists, Increment, Decrement, ListAppend, ListPrepend, SetAdd, SetDelete, Remove, Equal, MoreThan, DynamoDBTransactionMode as Mode } from '../dist/esm/index.js';
const aws = process.env.DYNAMODB_TEST_AWS === '1';
const endpoint = process.env.DYNAMODB_ENDPOINT || (aws ? undefined : 'http://127.0.0.1:8000');
const config = { region: process.env.AWS_REGION || 'us-east-1', ...(endpoint ? { endpoint } : {}), ...(!aws ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}) };
const prefix = process.env.DYNAMODB_TABLE_PREFIX || 'dynamodb-lib-test';
if (!/^[a-zA-Z0-9_.-]{3,100}$/.test(prefix)) throw new Error('Invalid test table prefix');
const name = `${prefix}-${randomUUID()}`;
const client = new DynamoDBClient(config);
const document = DynamoDBDocumentClient.from(client);
const table = { name, partitionKey: 'Pk', partitionKeyType: 'S', sortKey: 'Sk', sortKeyType: 'S', timeToLiveAttribute: 'ExpiresAt', globalSecondaryIndexes: [{ indexName: 'ByGroup', partitionKey: 'Group', sortKey: 'Rank', projectionType: 'ALL' }], localSecondaryIndexes: [{ indexName: 'ByRank', sortKey: 'Rank', projectionType: 'ALL' }] };
const tables = new Map([['items', table]]);
const service = new DynamoDBService({ ...config, tables });
const createdTables = [];
before(async () => {
  console.log(`Integration target: ${endpoint || 'AWS'}; temporary table: ${name}`);
  await client.send(new CreateTableCommand({ TableName: name, BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [{ AttributeName: 'Pk', AttributeType: 'S' }, { AttributeName: 'Sk', AttributeType: 'S' }, { AttributeName: 'Group', AttributeType: 'S' }, { AttributeName: 'Rank', AttributeType: 'N' }],
    KeySchema: [{ AttributeName: 'Pk', KeyType: 'HASH' }, { AttributeName: 'Sk', KeyType: 'RANGE' }],
    GlobalSecondaryIndexes: [{ IndexName: 'ByGroup', KeySchema: [{ AttributeName: 'Group', KeyType: 'HASH' }, { AttributeName: 'Rank', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }],
    LocalSecondaryIndexes: [{ IndexName: 'ByRank', KeySchema: [{ AttributeName: 'Pk', KeyType: 'HASH' }, { AttributeName: 'Rank', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }],
  }));
  createdTables.push(name);
  await waitUntilTableExists({ client, maxWaitTime: 120, minDelay: 1, maxDelay: 3 }, { TableName: name });
  await client.send(new UpdateTimeToLiveCommand({ TableName: name, TimeToLiveSpecification: { AttributeName: 'ExpiresAt', Enabled: true } }));
  for (const type of ['S', 'N', 'B']) {
    const singleName = `${name}-${type}`;
    await client.send(new CreateTableCommand({ TableName: singleName, BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: [{ AttributeName: 'Id', AttributeType: type }], KeySchema: [{ AttributeName: 'Id', KeyType: 'HASH' }] }));
    createdTables.push(singleName);
    await waitUntilTableExists({ client, maxWaitTime: 120, minDelay: 1, maxDelay: 3 }, { TableName: singleName });
    tables.set(type, { name: singleName, partitionKey: 'Id', partitionKeyType: type });
  }
}, { timeout: 540000 });
after(async () => {
  try {
    const results = await Promise.allSettled(createdTables.map(TableName => client.send(new DeleteTableCommand({ TableName }))));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(r => r.reason), `Test table cleanup failed: ${createdTables.join(', ')}`);
  }
  finally { service.destroy(); client.destroy(); }
});

test('CRUD, conflict behavior, nested values, casing and projections', async () => {
  assert.equal((await service.createOne('items', ['crud', 'a'], { display_name: 'Alice', value: { accessToken: 'a' } })).created, true);
  assert.deepEqual(await service.getOne('items', ['crud', 'a'], { consistentRead: true, projectionFields: ['DisplayName'] }, 'snake'), { display_name: 'Alice' });
  assert.equal((await service.createOne('items', ['crud', 'a'], {}, { onConflict: 'ignore' })).created, false);
  await service.update('items', ['crud', 'a'], [Assign('value.accessToken', 'b')]);
  assert.equal((await service.getOne('items', ['crud', 'a'], { consistentRead: true })).value.accessToken, 'b');
  assert.equal((await service.update('items', ['crud', 'missing'], [Assign('x', 1)], null, { upsert: false })).updatedOrCreated, false);
  assert.equal((await service.deleteOne('items', ['crud', 'a'])).deleted, true);
  assert.equal(await service.getOne('items', ['crud', 'a'], { consistentRead: true }), null);
});

test('all update groups, conditions and returned attributes', async () => {
  const key = ['updates', 'a'];
  await service.createOne('items', key, { count: 1, list: [2], tags: new Set(['a']), obsolete: true });
  await service.update('items', key, [Increment('count', 2), ListAppend('list', [3]), SetAdd('tags', new Set(['b'])), Remove('obsolete')]);
  const result = await service.update('items', key, [Decrement('count', 1), ListPrepend('list', [1]), SetDelete('tags', new Set(['a'])), AssignIfNotExists('value', 9)], Equal('count', 3), { returnValue: 'ALL_NEW' });
  assert.equal(result.item.count, 2); assert.deepEqual(result.item.list, [1, 2, 3]); assert.deepEqual(result.item.tags, new Set(['b'])); assert.equal(result.item.obsolete, undefined);
  assert.equal((await service.update('items', key, [Assign('count', 0)], Equal('count', 99))).updatedOrCreated, false);
  assert.equal((await service.deleteOne('items', key, Equal('count', 99))).deleted, false);
  assert.equal((await service.deleteOne('items', key, null, { returnValue: 'ALL_OLD' })).item.count, 2);
});

test('batches exceed both DynamoDB batch limits and preserve read order', async () => {
  const keys = Array.from({ length: 105 }, (_, i) => ['batch', String(i).padStart(3, '0')]);
  assert.equal((await service.createMany('items', keys, keys.map((_, i) => ({ count: i })))).numberOfItems, 105);
  const items = await service.getMany('items', [...keys].reverse().concat([['batch', 'missing']]), { consistentRead: true, projectionFields: ['Count'] });
  assert.equal(items.length, 106); assert.deepEqual(items[0], { count: 104 }); assert.equal(items[105], null);
  assert.equal((await service.deleteMany('items', keys)).numberOfItems, 105);
  assert.equal(await service.getOne('items', keys[0], { consistentRead: true }), null);
});

test('TTL hides expired rows, reports expiry and supports TTL removal', async () => {
  await document.send(new PutCommand({ TableName: name, Item: { Pk: 'ttl', Sk: 'expired', ExpiresAt: 1 } }));
  assert.equal(await service.getOne('items', ['ttl', 'expired'], { consistentRead: true }), null);
  const result = await service.createOne('items', ['ttl', 'alive'], {}, { ttl: 60 });
  assert.ok(result.expiresAt > Math.floor(Date.now() / 1000));
  await service.update('items', ['ttl', 'alive'], [Assign('x', 1)], null, { ttl: 0 });
  const item = await service.getOne('items', ['ttl', 'alive'], { consistentRead: true, projectionFields: ['ExpiresAt', 'X'] });
  assert.deepEqual(item, { x: 1 });
});

test('query pagination, filters, reverse order and sort-key operators', async () => {
  const keys = ['a', 'b', 'c', 'd'].map(k => ['query', k]);
  await service.createMany('items', keys, keys.map((_, i) => ({ count: i })));
  const first = await service.find('items', ['query'], null, { consistentRead: true, limit: 2 });
  assert.deepEqual(first.items.map(i => i.sk), ['a', 'b']); assert.ok(first.cursor);
  const second = await service.find('items', ['query'], null, { consistentRead: true, limit: 2, cursor: first.cursor });
  assert.deepEqual(second.items.map(i => i.sk), ['c', 'd']); assert.equal(second.cursor, undefined);
  assert.equal((await service.find('items', ['query', ['begins_with', 'a']], null, { consistentRead: true })).items.length, 1);
  assert.deepEqual((await service.find('items', ['query', ['BETWEEN', ['b', 'd']]], MoreThan('count', 1), { consistentRead: true, ascending: false })).items.map(i => i.sk), ['d', 'c']);
});

test('transactions read, write, check, update and delete atomically', async () => {
  const tx = service.transaction({ mode: Mode.WRITE });
  assert.equal((await tx.createOne('items', ['tx', 'a'], { count: 1 }).createOne('items', ['tx', 'b'], { count: 2 }).commit()).numberOfTransactItems, 2);
  const read = await service.transaction({ mode: Mode.READ }).getOne('items', ['tx', 'a']).getOne('items', ['tx', 'missing']).commit();
  assert.equal(read.items[0].count, 1); assert.equal(read.items[1], null);
  await service.transaction({ mode: Mode.WRITE }).check('items', ['tx', 'a'], Equal('count', 1)).update('items', ['tx', 'b'], [Increment('count', 1)]).commit();
  await assert.rejects(service.transaction({ mode: Mode.WRITE }).check('items', ['tx', 'a'], Equal('count', 99)).deleteOne('items', ['tx', 'b']).commit());
  assert.equal((await service.getOne('items', ['tx', 'b'], { consistentRead: true })).count, 3);
  await service.transaction({ mode: Mode.WRITE }).deleteOne('items', ['tx', 'a']).deleteOne('items', ['tx', 'b']).commit();
});

test('GSI and LSI pagination carries the complete table/index key', async () => {
  const keys = ['a', 'b', 'c'].map(k => ['index', k]);
  await service.createMany('items', keys, keys.map((_, rank) => ({ group: 'group-a', rank })));
  // GSIs are eventually consistent, including in the AWS test mode.
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await service.find('items', ['group-a'], null, { indexToScan: 'ByGroup' })).items.length === 3) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  for (const [indexToScan, condition] of [['ByGroup', ['group-a']], ['ByRank', ['index', ['BETWEEN', [0, 2]]]]]) {
    const first = await service.find('items', condition, null, { indexToScan, limit: 1 });
    assert.equal(first.items.length, 1); assert.equal(first.cursor.Pk, 'index'); assert.equal(first.cursor.Sk, 'a');
    const rest = await service.find('items', condition, null, { indexToScan, cursor: first.cursor });
    assert.deepEqual(rest.items.map(i => i.sk), ['b', 'c']);
  }
});

for (const [type, keys] of [['S', ['a', 'b']], ['N', [0, 42]], ['B', [Buffer.from([0, 1]), Buffer.from([2, 3])]]]) {
  test(`scalar ${type} keys work for CRUD, batches and transactions`, async () => {
    await service.createMany(type, keys, keys.map((_, count) => ({ count })));
    assert.equal((await service.getOne(type, keys[0], { consistentRead: true })).count, 0);
    assert.deepEqual((await service.getMany(type, [...keys].reverse(), { consistentRead: true, projectionFields: ['Count'] })), [{ count: 1 }, { count: 0 }]);
    assert.equal((await service.find(type, [keys[0]], null, { consistentRead: true })).items.length, 1);
    await service.transaction({ mode: Mode.WRITE }).update(type, keys[0], [Increment('count', 2)]).deleteOne(type, keys[1]).commit();
    assert.equal((await service.getOne(type, keys[0], { consistentRead: true })).count, 2);
    assert.equal(await service.getOne(type, keys[1], { consistentRead: true }), null);
    await service.deleteMany(type, keys);
  });
}
