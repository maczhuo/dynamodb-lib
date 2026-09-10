import { afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import * as lib from '../src/index.js';
const tables = new Map([['items', { name: 'test-items', partitionKey: 'Id', partitionKeyType: 'S' as const, timeToLiveAttribute: 'ExpiresAt' }]]);
const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
const instances: lib.DynamoDBService[] = [];
function setup() {
  const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send');
  const service = new lib.DynamoDBService({ tables, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }, logger);
  instances.push(service);
  return { service, send };
}
afterEach(() => { for (const s of instances.splice(0)) s.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('expressions', () => {
  it.each([
    ['Equal', '='], ['NotEqual', '<>'], ['MoreThan', '>'], ['MoreThanOrEqual', '>='], ['LessThan', '<'], ['LessThanOrEqual', '<='],
  ] as const)('%s preserves values and transforms root names', (name, op) => {
    const e = lib[name]('user_name', 'x');
    expect(e.expression).toBe(`#attr0 ${op} :val0`);
    expect([...e.expressionAttributeNameMap.values()]).toEqual(['UserName']);
    expect([...e.expressionAttributeValueMap!.values()]).toEqual(['x']);
  });
  it.each(['value.accessToken', 'value.items[0][1]', 'value.a\\.b', 'value.a\\[0\\]'])('supports nested path %s', path => {
    const e = lib.Equal(path, 1);
    expect([...e.expressionAttributeNameMap.values()][0]).toBe('Value');
    expect(e.expressionAttributeNameMap.size).toBeGreaterThan(1);
  });
  it('preserves nested case and escaped punctuation', () => {
    expect([...lib.Equal('value.accessToken', 1).expressionAttributeNameMap.values()]).toEqual(['Value', 'accessToken']);
    expect([...lib.Equal('value.a\\.b', 1).expressionAttributeNameMap.values()]).toEqual(['Value', 'a.b']);
    expect(lib.Equal('value.items[0][1]', 1).expression).toContain('[0][1]');
  });
  it.each([
    () => lib.Between('x', 1, 3), () => lib.In('x', [1, 2]), () => lib.AttributeExists('x'),
    () => lib.AttributeNotExists('x'), () => lib.AttributeType('x', 'N'), () => lib.BeginsWith('x', 'a'),
    () => lib.Contains('x', 1), () => lib.Size('x', '>=', 2),
  ])('builds predicate %#', make => expect(make().expression).toContain('#attr0'));
  it.each([
    [() => lib.Assign('x', 1), 'SET'], [() => lib.AssignIfNotExists('x', 1), 'SET'],
    [() => lib.Increment('x', 1), 'ADD'], [() => lib.Decrement('x', 1), 'ADD'],
    [() => lib.ListAppend('x', []), 'SET'], [() => lib.ListPrepend('x', []), 'SET'],
    [() => lib.ListAppend('x', [], true), 'SET'], [() => lib.ListPrepend('x', [], true), 'SET'],
    [() => lib.Remove('x'), 'REMOVE'], [() => lib.SetAdd('x', new Set([1])), 'ADD'],
    [() => lib.SetDelete('x', new Set([1])), 'DELETE'],
  ] as const)('builds update %#', (make, group) => expect(make().updateExpressionGroup).toBe(group));
  it('composes predicates without placeholder collisions', () => {
    const e = lib.And(lib.Equal('x', 1), lib.Or(lib.Equal('y', 2), lib.Not(lib.Equal('z', 3))));
    expect([...e.expressionAttributeValueMap!.values()]).toEqual([1, 2, 3]);
    expect(e.expression).toContain(' AND (');
    expect(lib.Not(lib.And(lib.Equal('x', 1), lib.Equal('y', 2))).expression).toMatch(/^NOT \(/);
  });
  it.each([
    () => lib.Between('x', 3, 1), () => lib.In('x', []), () => lib.Increment('x', NaN),
    () => lib.Decrement('x', Infinity), () => lib.ListAppend('x', 1 as any),
    () => lib.ListPrepend('x', 1 as any), () => lib.SetAdd('x', [] as any), () => lib.SetDelete('x', [] as any),
  ])('rejects invalid expression %#', make => expect(make).toThrow());
  it('handles empty strings', () => { expect(lib.ucFirst('')).toBe(''); expect(lib.lcFirst('ABC')).toBe('aBC'); });
});

describe('service', () => {
  it('requires configured tables', () => expect(() => new lib.DynamoDBService({ tables: new Map() })).toThrow());
  it('exports named and default constructor', () => expect(lib.default).toBe(lib.DynamoDBService));
  it('preserves error cause', () => { const cause = new Error('aws'); expect(new lib.DynamoDBError(500, { message: 'failed', cause }).cause).toBe(cause); });
  it.each(['getOne', 'getMany', 'createOne', 'createMany', 'update', 'deleteOne', 'deleteMany', 'find'])('rejects missing table in %s', async method => {
    const { service } = setup(); await expect((service as any)[method]('missing')).rejects.toThrow('not configured');
  });
  it.each(['camel', 'snake'] as const)('reads %s with TTL and projection', async casing => {
    const { service, send } = setup(); send.mockResolvedValue({ Item: { DisplayName: 'A', ExpiresAt: 9999999999 } } as never);
    expect(await service.getOne('items', 'a', { projectionFields: ['DisplayName'] }, casing)).toEqual(casing === 'camel' ? { displayName: 'A' } : { display_name: 'A' });
  });
  it('returns null for absent and expired items', async () => {
    const { service, send } = setup(); send.mockResolvedValueOnce({} as never).mockResolvedValueOnce({ Item: { Id: 'a', ExpiresAt: 1 } } as never);
    expect(await service.getOne('items', 'a')).toBeNull(); expect(await service.getOne('items', 'a')).toBeNull();
  });
  it.each(['ValidationException', 'InternalServerError'])('wraps get errors: %s', async name => {
    const { service, send } = setup(); const error = Object.assign(new Error('aws'), { name }); send.mockRejectedValue(error);
    await expect(service.getOne('items', 'a')).rejects.toMatchObject({ status: name === 'ValidationException' ? 400 : 500, cause: error });
  });
  it('creates with native epoch TTL', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(100000));
    const { service, send } = setup(); send.mockResolvedValue({} as never);
    expect(await service.createOne('items', 'a', { display_name: 'A' }, { ttl: 30 })).toEqual({ created: true, expiresAt: 130 });
    expect((send.mock.calls[0][0] as any).input.Item).toEqual({ Id: 'a', DisplayName: 'A', ExpiresAt: 130 });
  });
  it('reports replacement and ignored conflict', async () => {
    const { service, send } = setup(); send.mockResolvedValueOnce({ Attributes: { Id: 'a', DisplayName: 'old' } } as never)
      .mockRejectedValueOnce(Object.assign(new Error(), { name: 'ConditionalCheckFailedException' }));
    expect(await service.createOne('items', 'a', {})).toMatchObject({ created: false, replacedItem: { displayName: 'old' } });
    expect(await service.createOne('items', 'a', {}, { onConflict: 'ignore' })).toEqual({ created: false });
  });
  it('does not mutate update commands when adding TTL', async () => {
    const { service, send } = setup(); send.mockResolvedValue({ Attributes: { Id: 'a', Count: 2 } } as never);
    const commands = [lib.Increment('count', 1)];
    expect(await service.update('items', 'a', commands, lib.Equal('count', 1), { ttl: 60, upsert: false })).toMatchObject({ updatedOrCreated: true, item: { count: 2 } });
    expect(commands).toHaveLength(1);
  });
  it.each(['update', 'deleteOne'] as const)('%s handles conditional failure', async method => {
    const { service, send } = setup(); send.mockRejectedValue(Object.assign(new Error(), { name: 'ConditionalCheckFailedException' }));
    const result = method === 'update' ? await service.update('items', 'a', [lib.Remove('x')]) : await service.deleteOne('items', 'a');
    expect(result).toEqual(method === 'update' ? { updatedOrCreated: false } : { deleted: false });
  });
  it.each(['update', 'deleteOne', 'createOne'] as const)('%s wraps failures', async method => {
    const { service, send } = setup(); send.mockRejectedValue(new Error('network'));
    const result = method === 'update' ? service.update('items', 'a', [lib.Remove('x')]) : method === 'createOne' ? service.createOne('items', 'a', {}) : service.deleteOne('items', 'a');
    await expect(result).rejects.toBeInstanceOf(lib.DynamoDBError);
  });
  it('reports successful deletion without ReturnValues', async () => {
    const { service, send } = setup(); send.mockResolvedValue({} as never); expect(await service.deleteOne('items', 'a')).toEqual({ deleted: true });
  });
  it('validates batch inputs and empty updates', async () => {
    const { service } = setup(); await expect(service.createMany('items', [], [])).rejects.toThrow();
    await expect(service.createMany('items', ['a'], [])).rejects.toThrow();
    await expect(service.createMany('items', ['a', 'b'], [{}])).rejects.toThrow('mismatch');
    await expect(service.update('items', 'a', [])).rejects.toThrow();
    expect(await service.getMany('items', [])).toEqual([]); expect(await service.deleteMany('items', [])).toEqual({ numberOfItems: 0 });
  });
  it.each(['createMany', 'deleteMany'] as const)('%s splits 26 items and retries unprocessed work', async method => {
    vi.useFakeTimers(); const { service, send } = setup();
    const request = method === 'createMany' ? { PutRequest: { Item: { Id: '0' } } } : { DeleteRequest: { Key: { Id: '0' } } };
    send.mockResolvedValueOnce({ UnprocessedItems: { 'test-items': [request] } } as never).mockResolvedValue({} as never);
    const keys = Array.from({ length: 26 }, (_, i) => String(i));
    const promise = method === 'createMany' ? service.createMany('items', keys, keys.map(() => ({}))) : service.deleteMany('items', keys);
    await vi.runAllTimersAsync(); expect(await promise).toEqual({ numberOfItems: 26 }); expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0][0] as any).input.RequestItems['test-items']).toHaveLength(25);
  });
  it('restores batch read order and missing items', async () => {
    const { service, send } = setup(); send.mockResolvedValue({ Responses: { 'test-items': [{ Id: 'b' }, { Id: 'a' }] } } as never);
    expect(await service.getMany('items', ['a', 'missing', 'b'])).toEqual([{ id: 'a' }, null, { id: 'b' }]);
  });
  it('continues query after empty filtered page', async () => {
    const { service, send } = setup(); send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { Id: 'a' } } as never).mockResolvedValueOnce({ Items: [{ Id: 'b' }] } as never);
    expect(await service.find('items', ['b'])).toEqual({ items: [{ id: 'b' }] }); expect(send).toHaveBeenCalledTimes(2);
  });
  it('does not send read operations in write transactions', () => {
    const { service } = setup(); expect(() => service.transaction({ mode: lib.DynamoDBTransactionMode.WRITE }).getOne('items', 'a')).toThrow('not READ');
  });
  it('commits and cleans transactions', async () => {
    const { service, send } = setup(); send.mockResolvedValue({} as never);
    const tx = service.transaction({ mode: lib.DynamoDBTransactionMode.WRITE });
    expect(await tx.createOne('items', 'a', {}).commit()).toEqual({ numberOfTransactItems: 1 });
    expect(await tx.deleteOne('items', 'a').commit()).toEqual({ numberOfTransactItems: 1 });
  });
  it('makes at least one attempt with retry limit zero', async () => {
    const { service, send } = setup(); send.mockResolvedValue({} as never);
    await service.transaction({ mode: lib.DynamoDBTransactionMode.WRITE }).txConflictRetryWrapper(new TransactWriteCommand({ TransactItems: [] }), 0, 0);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('retries transaction conflict only', async () => {
    vi.useFakeTimers(); const { service, send } = setup();
    send.mockRejectedValueOnce(Object.assign(new Error('conflict'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }] })).mockResolvedValue({} as never);
    const promise = service.transaction({ mode: lib.DynamoDBTransactionMode.WRITE }).createOne('items', 'a', {}).commit();
    await vi.runAllTimersAsync(); await promise; expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('failure paths and API combinations', () => {
  it.each(['getMany', 'createMany', 'deleteMany'] as const)('%s bounds unprocessed retries', async method => {
    vi.useFakeTimers(); const { service, send } = setup();
    send.mockResolvedValue((method === 'getMany' ? { UnprocessedKeys: { 'test-items': { Keys: [{ Id: 'a' }] } } } : { UnprocessedItems: { 'test-items': [method === 'createMany' ? { PutRequest: { Item: { Id: 'a' } } } : { DeleteRequest: { Key: { Id: 'a' } } }] } }) as never);
    const promise = method === 'createMany' ? service.createMany('items', ['a'], [{}]) : service[method]('items', ['a']);
    const assertion = expect(promise).rejects.toThrow('multiple attempts');
    await vi.runAllTimersAsync(); await assertion; expect(send).toHaveBeenCalledTimes(11);
  });
  it.each(['createMany', 'deleteMany'] as const)('%s wraps batch errors', async method => {
    const { service, send } = setup(); send.mockRejectedValue(new Error('network'));
    await expect(method === 'createMany' ? service.createMany('items', ['a'], [{}]) : service.deleteMany('items', ['a'])).rejects.toBeInstanceOf(lib.DynamoDBError);
  });
  it.each(['camel', 'snake'] as const)('batch projections, expiration and casing %s', async casing => {
    const { service, send } = setup(); send.mockResolvedValue({ Responses: { 'test-items': [{ Id: 'a', DisplayName: 'A', ExpiresAt: 9999999999 }, { Id: 'b', ExpiresAt: 1 }] } } as never);
    expect(await service.getMany('items', ['a', 'b'], { projectionFields: ['DisplayName'] }, casing)).toEqual([casing === 'camel' ? { displayName: 'A' } : { display_name: 'A' }, null]);
  });
  it('rejects duplicate keys and handles binary batch response keys', async () => {
    const { service, send } = setup(); await expect(service.getMany('items', ['a', 'a'])).rejects.toThrow('Duplicate');
    send.mockResolvedValue({ Responses: { 'test-items': [{ Id: new Uint8Array([1, 2]), Value: 1 }] } } as never);
    expect(await service.getMany('items', [Buffer.from([1, 2])], { projectionFields: ['Value'] })).toEqual([{ value: 1 }]);
  });
  it('does not confuse comma-containing composite keys', async () => {
    const service = new lib.DynamoDBService({ tables: new Map([['t', { name: 'test-items', partitionKey: 'Pk', partitionKeyType: 'S', sortKey: 'Sk', sortKeyType: 'S' }]]) }); instances.push(service);
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockResolvedValue({ Responses: { 'test-items': [{ Pk: 'a,b', Sk: 'c' }, { Pk: 'a', Sk: 'b,c' }] } } as never);
    expect(await service.getMany('t', [['a,b', 'c'], ['a', 'b,c']])).toHaveLength(2);
  });
  it.each(['update', 'deleteOne'] as const)('%s validation exception', async method => {
    const { service, send } = setup(); send.mockRejectedValue(Object.assign(new Error('invalid'), { name: 'ValidationException' }));
    await expect(method === 'update' ? service.update('items', 'a', [lib.Assign('x', 1)]) : service.deleteOne('items', 'a')).rejects.toMatchObject({ status: 400 });
  });
  it.each(['camel', 'snake'] as const)('returned item casing %s', async casing => {
    const { service, send } = setup(); send.mockResolvedValue({ Attributes: { DisplayName: 'A' } } as never);
    const expected = casing === 'camel' ? { displayName: 'A' } : { display_name: 'A' };
    expect((await service.createOne('items', 'a', {}, {}, casing)).replacedItem).toEqual(expected);
    expect((await service.update('items', 'a', [lib.Assign('display_name', 'A')], null, { ttl: 0, returnValue: 'ALL_NEW' }, casing)).item).toEqual(expected);
    expect((await service.deleteOne('items', 'a', lib.Equal('display_name', 'A'), { returnValue: 'ALL_OLD' }, casing)).item).toEqual(expected);
  });
  it.each(['READ', 'WRITE'] as const)('%s transaction errors retain cause and status', async mode => {
    const { service, send } = setup();
    for (const [name, status] of [['TransactionCanceledException', 400], ['ValidationException', mode === 'READ' ? 500 : 400], ['InternalServerError', 500]]) {
      const cause = Object.assign(new Error(name), { name }); send.mockRejectedValue(cause);
      const tx = service.transaction({ mode: mode as lib.DynamoDBTransactionMode });
      mode === 'READ' ? tx.getOne('items', 'a') : tx.createOne('items', 'a', {});
      await expect(tx.commit()).rejects.toMatchObject({ status, cause });
    }
  });
  it.each(['READ', 'WRITE'] as const)('%s exhausted transaction conflicts', async mode => {
    vi.useFakeTimers(); const { service, send } = setup();
    send.mockRejectedValue(Object.assign(new Error('conflict'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }] }));
    const tx = service.transaction({ mode: mode as lib.DynamoDBTransactionMode }); mode === 'READ' ? tx.getOne('items', 'a') : tx.deleteOne('items', 'a');
    const assertion = expect(tx.commit()).rejects.toMatchObject({ status: 409 }); await vi.runAllTimersAsync(); await assertion;
  });
  it.each(['camel', 'snake'] as const)('transaction reads include missing, expired and projected values %s', async casing => {
    const { service, send } = setup(); send.mockResolvedValue({ Responses: [{ Item: { DisplayName: 'A', ExpiresAt: 9999999999 } }, { Item: { ExpiresAt: 1 } }, {}] } as never);
    const result = await service.transaction({ mode: lib.DynamoDBTransactionMode.READ }).getOne('items', 'a', { projectionFields: ['DisplayName'] }).getOne('items', 'b').getOne('items', 'c').commit(casing);
    expect(result.items![0]).toHaveProperty(casing === 'camel' ? 'displayName' : 'display_name', 'A'); expect(result.items!.slice(1)).toEqual([null, null]);
  });
  it('validates transaction operations and limits', () => {
    const { service } = setup(); const read = service.transaction({ mode: lib.DynamoDBTransactionMode.READ });
    const write = service.transaction({ mode: lib.DynamoDBTransactionMode.WRITE });
    expect(() => service.transaction({ mode: 'invalid' as any })).toThrow();
    for (const tx of [read, write]) {
      for (const method of ['getOne', 'createOne', 'update', 'deleteOne', 'check']) {
        expect(() => (tx as any)[method]('missing', 'a', [])).toThrow();
      }
    }
    expect(() => write.update('items', 'a', [])).toThrow();
    expect(() => write.check('items', 'a', new lib.DynamoDBExpression())).toThrow();
    for (let i = 0; i < 25; i++) { read.getOne('items', String(i)); write.createOne('items', String(i), {}); }
    expect(() => read.getOne('items', 'overflow')).toThrow('25');
    for (const method of ['createOne', 'update', 'deleteOne', 'check']) expect(() => (write as any)[method]('items', 'overflow', [])).toThrow('25');
  });
  it('transaction TTL changes do not mutate caller input', async () => {
    const { service, send } = setup(); send.mockResolvedValue({} as never); const commands = [lib.Assign('x', 1)];
    await service.transaction({ mode: lib.DynamoDBTransactionMode.WRITE, now: 100 }).update('items', 'a', commands, lib.Equal('x', 0), { ttl: 60, upsert: false }).commit();
    expect(commands).toHaveLength(1);
    await service.transaction({ mode: lib.DynamoDBTransactionMode.WRITE }).update('items', 'a', [], null, { ttl: 0 }).commit();
  });
  it.each(['ValidationException', 'InternalServerError'])('query error %s', async name => {
    const { service, send } = setup(); send.mockRejectedValue(Object.assign(new Error('aws'), { name }));
    await expect(service.find('items', ['a'])).rejects.toMatchObject({ status: name === 'ValidationException' ? 400 : 500 });
  });
  it.each(['camel', 'snake'] as const)('query limits, TTL, projection and casing %s', async casing => {
    const { service, send } = setup(); send.mockResolvedValue({ Items: [{ Id: 'expired', ExpiresAt: 1 }, { Id: 'a', DisplayName: 'A' }, { Id: 'b', DisplayName: 'B' }] } as never);
    const result = await service.find('items', lib.Equal('id', 'a'), lib.AttributeExists('display_name'), { limit: 1, projectionFields: ['DisplayName'] }, casing);
    expect(result.cursor).toBe('a'); expect(result.items).toEqual([casing === 'camel' ? { displayName: 'A' } : { display_name: 'A' }]);
  });
  it('rejects invalid query options before sending', async () => {
    const { service } = setup();
    await expect(service.find('items', [], null, {} as any)).rejects.toThrow();
    await expect(service.find('items', ['a'], null, { limit: 0 })).rejects.toThrow();
    await expect(service.find('items', ['a'], null, { indexToScan: 'missing' })).rejects.toThrow();
    await expect(service.find('items', ['a', 'b'])).rejects.toThrow();
    await expect(service.find('items', 'bad' as any)).rejects.toThrow();
  });
  it('reuses query predicates without modifying their maps', async () => {
    const { service, send } = setup(); send.mockResolvedValue({ Items: [] } as never); const condition = lib.Equal('id', 'a');
    await service.find('items', condition, lib.Equal('value', 1), { projectionFields: ['Id'] });
    expect(condition.expressionAttributeNameMap.size).toBe(1); expect(condition.expressionAttributeValueMap!.size).toBe(1);
  });
});

describe('operational logging', () => {
  it('reports read outcomes without logging keys, items, or error messages', async () => {
    vi.clearAllMocks();
    const { service, send } = setup();
    send.mockResolvedValueOnce({ Item: { Id: 'private-key', Token: 'private-value' } } as never)
      .mockResolvedValueOnce({ Item: { Id: 'private-key', ExpiresAt: 1 } } as never)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(Object.assign(new Error('private-error-message'), { name: 'ValidationException' }));
    await service.getOne('items', 'private-key');
    await service.getOne('items', 'private-key');
    await service.getOne('items', 'private-key');
    await expect(service.getOne('items', 'private-key')).rejects.toMatchObject({ status: 400 });
    for (const outcome of ['found', 'expired', 'not-found']) {
      expect(logger.debug).toHaveBeenCalledWith('DynamoDB getOne completed', { tableKey: 'items', outcome });
    }
    expect(logger.error).toHaveBeenCalledWith('The request parameters are invalid', { tableKey: 'items', errorName: 'ValidationException' });
    expect(JSON.stringify([logger.debug.mock.calls, logger.error.mock.calls])).not.toContain('private-');
  });

  it('keeps expected condition failures at debug level and omits expressions and values', async () => {
    vi.clearAllMocks();
    const { service, send } = setup();
    send.mockRejectedValue(Object.assign(new Error('private-error'), { name: 'ConditionalCheckFailedException' }));
    await service.update('items', 'private-key', [lib.Assign('token', 'private-value')], lib.Equal('token', 'private-condition'));
    await service.deleteOne('items', 'private-key', lib.Equal('token', 'private-condition'));
    await service.createOne('items', 'private-key', { token: 'private-value' }, { onConflict: 'ignore' });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith('DynamoDB update skipped: condition not met', { tableKey: 'items' });
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('private-');
  });

  it.each(['getMany', 'createMany', 'deleteMany'] as const)('%s explains retry delay without logging batch payloads', async method => {
    vi.clearAllMocks(); vi.useFakeTimers();
    const { service, send } = setup();
    const key = { Id: 'private-key' };
    const response = method === 'getMany' ? { UnprocessedKeys: { 'test-items': { Keys: [key] } } }
      : { UnprocessedItems: { 'test-items': [method === 'createMany' ? { PutRequest: { Item: { ...key, Token: 'private-value' } } } : { DeleteRequest: { Key: key } }] } };
    send.mockResolvedValueOnce(response as never).mockResolvedValue({} as never);
    const promise = method === 'createMany' ? service.createMany('items', ['private-key'], [{ token: 'private-value' }]) : service[method]('items', ['private-key']);
    await vi.runAllTimersAsync(); await promise;
    expect(logger.warn).toHaveBeenCalledWith('DynamoDB retrying unprocessed batch items', expect.objectContaining({ operation: method, tableKey: 'items', itemCount: 1, attempt: 1, delayMs: expect.any(Number) }));
    expect(logger.debug).toHaveBeenCalledWith(`DynamoDB ${method} completed`, expect.any(Object));
    expect(JSON.stringify([logger.debug.mock.calls, logger.warn.mock.calls])).not.toContain('private-');
  });

  it('reports transaction conflicts and completion without cancellation messages or items', async () => {
    vi.clearAllMocks(); vi.useFakeTimers();
    const { service, send } = setup();
    send.mockRejectedValueOnce(Object.assign(new Error('private-error'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict', Message: 'private-reason' }] })).mockResolvedValue({} as never);
    const promise = service.transaction({ mode: lib.DynamoDBTransactionMode.WRITE }).createOne('items', 'private-key', { token: 'private-value' }).commit();
    await vi.runAllTimersAsync(); await promise;
    expect(logger.warn).toHaveBeenCalledWith('DynamoDB retrying transaction conflict', { mode: 'WRITE', attempt: 1, maxAttempts: 3, delayMs: 50 });
    expect(logger.debug).toHaveBeenCalledWith('DynamoDB transaction completed', { mode: 'WRITE', itemCount: 1 });
    expect(JSON.stringify([logger.debug.mock.calls, logger.warn.mock.calls])).not.toContain('private-');
  });
});
