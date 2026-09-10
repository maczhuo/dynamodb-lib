import { Agent } from 'https';

import {
  TransactionCanceledException,
  DynamoDBClient,
  type DynamoDBClientConfig,
  ScalarAttributeType,
  ReturnConsumedCapacity,
  ReturnValue,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  BatchGetCommand,
  QueryCommand,
  QueryCommandInput,
  PutCommand,
  BatchWriteCommand,
  UpdateCommand,
  DeleteCommand,
  TransactGetCommand,
  TransactWriteCommand,
  TransactGetCommandInput,
  TransactWriteCommandInput,
  TransactGetCommandOutput,
  TransactWriteCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { diff, camel, snake } from 'radash';

export type DynamoDBGSIConfig = {
  indexName: string;
  partitionKey: string;
  sortKey?: string;
  projectionType: 'ALL' | 'KEYS_ONLY' | 'INCLUDE';
  nonKeyAttributes?: string[];
};

export type DynamoDBLSIConfig = {
  indexName: string;
  sortKey: string;
  projectionType: 'ALL' | 'KEYS_ONLY' | 'INCLUDE';
  nonKeyAttributes?: string[];
};

export type DynamoDBTableDefinition = {
  name: string;
  partitionKey: string;
  partitionKeyType: ScalarAttributeType;
  sortKey?: string;
  sortKeyType?: ScalarAttributeType;
  nonKeyAttributeDefinitions?: {
    name: string;
    type: ScalarAttributeType;
  }[];
  localSecondaryIndexes?: DynamoDBLSIConfig[];
  globalSecondaryIndexes?: DynamoDBGSIConfig[];
  timeToLiveAttribute?: string;
};

export interface DynamoDBLogger {
  debug(message: string, ...meta: any[]): unknown;
  warn(message: string, ...meta: any[]): unknown;
  error(message: string, ...meta: any[]): unknown;
}
const silentLogger: DynamoDBLogger = { debug() {}, warn() {}, error() {} };
export class DynamoDBError extends Error {
  constructor(public readonly status: number, options: { message: string; cause?: unknown }) {
    super(options.message, { cause: options.cause });
    this.name = 'DynamoDBError';
  }
}
export const ucFirst = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
export const lcFirst = (value: string): string => value.charAt(0).toLowerCase() + value.slice(1);
const getUnixTime = (date: Date): number => Math.floor(date.getTime() / 1000);

export type DynamoDBConfig = {
  region?: DynamoDBClientConfig['region'];
  credentials?: DynamoDBClientConfig['credentials'];
  endpoint?: string;
  maxSockets?: number;
  requestTimeout?: number;
  txRetryLimit?: number;
  txRetryDelay?: number;
  tables: Map<string, DynamoDBTableDefinition>;
};

export type DynamoDBFindOptions = {
  consistentRead?: boolean;
  projectionFields?: string[];
  returnConsumedCapacity?: ReturnConsumedCapacity;
  indexToScan?: string;
  limit?: number;
  ascending?: boolean;
  cursor?:
  | Record<string, string | number | Buffer>
  | string
  | number
  | Buffer
  | [string | number | Buffer, string | number | Buffer];
};

export type DynamoDBFindResult<T> = {
  items: T[];
  cursor?:
  | Record<string, string | number | Buffer>
  | string
  | number
  | Buffer
  | [string | number | Buffer, string | number | Buffer];
};

export type DynamoDBCreateOptions = {
  ttl?: number;
  returnConsumedCapacity?: ReturnConsumedCapacity;
  onConflict?: 'replace' | 'ignore'; // Default is 'replace'
};

export type DynamoDBCreateOneResult = {
  created: boolean;
  replacedItem?: Record<string, any>;
  expiresAt?: number;
};

export type DynamoDBCreateManyResult = {
  numberOfItems: number;
  expiresAt?: number;
};

export type DynamoDBUpdateOptions = {
  returnValue?: ReturnValue;
  upsert?: boolean; // Default is true
  ttl?: number;
  returnConsumedCapacity?: ReturnConsumedCapacity;
};

export type DynamoDBUpdateResult<T> = {
  updatedOrCreated: boolean;
  expiresAt?: number;
  item?: Partial<T>;
};

export type DynamoDBDeleteOptions = {
  returnValue?: 'ALL_OLD' | 'NONE';
  returnConsumedCapacity?: ReturnConsumedCapacity;
};

export type DynamoDBDeleteOneResult<T> = {
  deleted: boolean;
  item?: T;
};

export type DynamoDBDeleteManyResult = {
  numberOfItems: number;
};

export type DynamoDBTransactionOptions = {
  mode: DynamoDBTransactionMode;
  now?: number;
  returnConsumedCapacity?: ReturnConsumedCapacity;
};

export type DynamoDBTransactionResult<T> = {
  items?: T[];
  numberOfTransactItems: number;
};

function isTransactionConflictError(error: Error): boolean {
  return (
    error.name === 'TransactionCanceledException' &&
    (error as TransactionCanceledException).CancellationReasons?.some(
      reason => reason.Code === 'TransactionConflict',
    ) === true
  );
}

const MAX_UNPROCESSED_ATTEMPTS = 10;

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const backoffDelayMs = (attempt: number): number =>
  Math.min(50 * 2 ** attempt, 1000);

function serializeKey(key: unknown): string {
  return JSON.stringify((Array.isArray(key) ? key : [key]).map(value =>
    value instanceof Uint8Array ? ['binary', Buffer.from(value).toString('base64')] : [typeof value, value],
  ));
}

function transformExpressionAttribute(
  attribute: string,
  names: Map<string, string>,
  prefix = '#attr',
): string {
  const parts = attribute.split(/(?<!\\)\.(?!\.)/);
  return parts.map((part, index) => {
    const indices = part.match(/(?<!\\)(?:\[\d+\])+$/)?.[0] ?? '';
    const raw = (indices ? part.slice(0, -indices.length) : part).replace(/\\([.\[\]\\])/g, '$1');
    if (!raw) throw new Error('Attribute path must not contain empty segments');
    const name = index === 0 ? ucFirst(camel(raw)) : raw;
    let key = [...names].find(([, value]) => value === name)?.[0];
    if (!key) {
      let i = names.size;
      while (names.has(`${prefix}${i}`)) i++;
      key = `${prefix}${i}`;
      names.set(key, name);
    }
    return key + indices;
  }).join('.');
}

function createComparisonExpression<T>(
  operator: '=' | '<' | '<=' | '>' | '>=' | '<>',
  attribute: string,
  value: T,
) {
  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', value);

  const expression = `${transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  )} ${operator} :val0`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
  );
}

function createUpdateExpression(expressions: DynamoDBExpression[]) {
  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  const updateExpressionGroups: Map<
    'SET' | 'REMOVE' | 'ADD' | 'DELETE',
    string[]
  > = new Map();
  expressions.forEach((expr, indx) => {
    if (expr.updateExpressionGroup === undefined) {
      throw new Error(
        'Only expressions with updateExpressionGroup are allowed',
      );
    }
    expr.expressionAttributeNameMap.forEach((value, key) => {
      key = key.replace('#attr', `#attr${indx}_`);
      expressionAttributeNameMap.set(key, value);
    });
    let childExpression = expr.expression.replace(/#attr/g, `#attr${indx}_`);

    if (expr.expressionAttributeValueMap) {
      expr.expressionAttributeValueMap.forEach((value, key) => {
        key = key.replace(':val', `:val${indx}_`);
        expressionAttributeValueMap.set(key, value);
      });
      childExpression = childExpression.replace(/:val/g, `:val${indx}_`);
    }

    if (!updateExpressionGroups.has(expr.updateExpressionGroup)) {
      updateExpressionGroups.set(expr.updateExpressionGroup, [childExpression]);
    } else {
      updateExpressionGroups
        .get(expr.updateExpressionGroup)!
        .push(childExpression);
    }
  });

  const expression = Array.from(updateExpressionGroups)
    .map(([group, expressions]) => `${group} ${expressions.join(', ')}`)
    .join(' ');

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
  );
}

export function MoreThan<T>(attribute: string, value: T) {
  return createComparisonExpression<T>('>', attribute, value);
}

export function MoreThanOrEqual<T>(attribute: string, value: T) {
  return createComparisonExpression<T>('>=', attribute, value);
}

export function LessThan<T>(attribute: string, value: T) {
  return createComparisonExpression<T>('<', attribute, value);
}

export function LessThanOrEqual<T>(attribute: string, value: T) {
  return createComparisonExpression<T>('<=', attribute, value);
}

export function NotEqual<T>(attribute: string, value: T) {
  return createComparisonExpression<T>('<>', attribute, value);
}

export function Equal<T>(attribute: string, value: T) {
  return createComparisonExpression<T>('=', attribute, value);
}

export function Between<T>(attribute: string, lowerBound: T, upperBound: T) {
  if (
    typeof lowerBound === 'number' &&
    typeof upperBound === 'number' &&
    lowerBound > upperBound
  ) {
    throw new Error('Lower bound must be less than upper bound');
  }

  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', lowerBound);
  expressionAttributeValueMap.set(':val1', upperBound);

  const expression = `${transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  )} BETWEEN :val0 AND :val1`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
  );
}

export function In<T>(attribute: string, values: Array<T>) {
  if (values.length === 0 || values.length > 100) {
    throw new Error('Values must not be empty');
  }

  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  values.forEach((value, indx) => {
    expressionAttributeValueMap.set(`:val${indx}`, value);
  });

  const expression = `${transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  )} IN (${Array.from(expressionAttributeValueMap.keys()).join(', ')})`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
  );
}

export function AttributeExists(attribute: string) {
  const expressionAttributeNameMap = new Map();

  const expression = `attribute_exists(${transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  )})`;

  return new DynamoDBExpression(expressionAttributeNameMap, null, expression);
}

export function AttributeNotExists(attribute: string) {
  const expressionAttributeNameMap = new Map();

  const expression = `attribute_not_exists(${transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  )})`;

  return new DynamoDBExpression(expressionAttributeNameMap, null, expression);
}

export function AttributeType(
  attribute: string,
  valueType: 'S' | 'N' | 'B' | 'SS' | 'NS' | 'BS' | 'BOOL' | 'NULL' | 'L' | 'M',
) {
  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', valueType);

  const expression = `attribute_type(${transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  )}, :val0)`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
  );
}

export function BeginsWith(attribute: string, prefix: string) {
  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', prefix);

  const expression = `begins_with(${transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  )}, :val0)`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
  );
}

export function Contains<T>(attribute: string, operand: T) {
  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', operand);

  const expression = `contains(${transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  )}, :val0)`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
  );
}

export function Size(
  attribute: string,
  operator: '=' | '<>' | '<' | '<=' | '>' | '>=',
  value: number,
) {
  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', value);

  const expression = `size(${transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  )}) ${operator} :val0`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
  );
}

export function Not(expression: DynamoDBExpression) {
  let expr = expression.expression;
  if (
    (expr.includes(' OR ') || expr.includes(' AND ')) &&
    !expr.startsWith('(')
  ) {
    expr = `(${expr})`;
  }

  expr = `NOT ${expr}`;
  return new DynamoDBExpression(
    expression.expressionAttributeNameMap,
    expression.expressionAttributeValueMap,
    expr,
  );
}

export function And(...expressions: DynamoDBExpression[]) {
  if (!expressions.length) throw new Error('At least one expression is required');
  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  const expression = expressions
    .map((expr, indx) => {
      expr.expressionAttributeNameMap.forEach((value, key) => {
        key = key.replace('#attr', `#attr${indx}_`);
        expressionAttributeNameMap.set(key, value);
      });
      let childExpression = expr.expression.replace(/#attr/g, `#attr${indx}_`);

      if (expr.expressionAttributeValueMap) {
        expr.expressionAttributeValueMap.forEach((value, key) => {
          key = key.replace(':val', `:val${indx}_`);
          expressionAttributeValueMap.set(key, value);
        });
        childExpression = childExpression.replace(/:val/g, `:val${indx}_`);
      }

      // If expression contains a `OR` or `AND` or `NOT` operator, wrap it in parentheses
      return (childExpression.includes(' OR ') ||
        childExpression.includes(' AND ')) &&
        !childExpression.startsWith('(')
        ? `(${childExpression})` // Wrap in parentheses
        : childExpression;
    })
    .join(' AND ');

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
  );
}

export function Or(...expressions: DynamoDBExpression[]) {
  if (!expressions.length) throw new Error('At least one expression is required');
  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  const expression = expressions
    .map((expr, indx) => {
      expr.expressionAttributeNameMap.forEach((value, key) => {
        key = key.replace('#attr', `#attr${indx}_`);
        expressionAttributeNameMap.set(key, value);
      });
      let childExpression = expr.expression.replace(/#attr/g, `#attr${indx}_`);

      if (expr.expressionAttributeValueMap) {
        expr.expressionAttributeValueMap.forEach((value, key) => {
          key = key.replace(':val', `:val${indx}_`);
          expressionAttributeValueMap.set(key, value);
        });
        childExpression = childExpression.replace(/:val/g, `:val${indx}_`);
      }

      // If expression contains a `OR` or `AND` operator, wrap it in parentheses
      return (childExpression.includes(' OR ') ||
        childExpression.includes(' AND ')) &&
        !childExpression.startsWith('(')
        ? `(${childExpression})` // Wrap in parentheses
        : childExpression;
    })
    .join(' OR ');

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
  );
}

export function Assign(attribute: string, value: any) {
  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', value);

  const expression = `${transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  )} = :val0`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
    'SET',
  );
}

export function AssignIfNotExists(attribute: string, value: any) {
  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', value);

  const path = transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  );
  const expression = `${path} = if_not_exists(${path}, :val0)`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
    'SET',
  );
}

export function Increment(attribute: string, value: number) {
  if (!Number.isFinite(value)) {
    throw new Error('Value must be a number');
  }

  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', value);

  const path = transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  );
  const expression = `${path} :val0`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
    'ADD',
  );
}

export function Decrement(attribute: string, value: number) {
  if (!Number.isFinite(value)) {
    throw new Error('Value must be a number');
  }
  value = -value;
  return Increment(attribute, value);
}

export function ListAppend(
  attribute: string,
  value: Array<any>,
  upsert = false,
) {
  if (!Array.isArray(value)) {
    throw new Error('Value must be an array');
  }

  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', value);
  if (upsert) {
    expressionAttributeValueMap.set(':val1', []);
  }

  const path = transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  );

  const expression = upsert
    ? `${path} = list_append(if_not_exists(${path}, :val1), :val0)`
    : `${path} = list_append(${path}, :val0)`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
    'SET',
  );
}

export function ListPrepend(
  attribute: string,
  value: Array<any>,
  upsert = false,
) {
  if (!Array.isArray(value)) {
    throw new Error('Value must be an array');
  }

  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', value);
  if (upsert) {
    expressionAttributeValueMap.set(':val1', []);
  }

  const path = transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  );

  const expression = upsert
    ? `${path} = list_append(:val0, if_not_exists(${path}, :val1))`
    : `${path} = list_append(:val0, ${path})`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
    'SET',
  );
}

export function Remove(attribute: string) {
  const expressionAttributeNameMap = new Map();

  const expression = transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  );

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    null,
    expression,
    'REMOVE',
  );
}

export function SetAdd(attribute: string, value: Set<any>) {
  if (!(value instanceof Set) || value.size === 0) {
    throw new Error('Value must be a Set');
  }

  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', value);

  const path = transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  );

  const expression = `${path} :val0`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
    'ADD',
  );
}

export function SetDelete(attribute: string, value: Set<any>) {
  if (!(value instanceof Set) || value.size === 0) {
    throw new Error('Value must be a Set');
  }

  const expressionAttributeNameMap = new Map();
  const expressionAttributeValueMap = new Map();
  expressionAttributeValueMap.set(':val0', value);

  const path = transformExpressionAttribute(
    attribute,
    expressionAttributeNameMap,
  );

  const expression = `${path} :val0`;

  return new DynamoDBExpression(
    expressionAttributeNameMap,
    expressionAttributeValueMap,
    expression,
    'DELETE',
  );
}

export class DynamoDBExpression {
  constructor(
    public expressionAttributeNameMap: Map<string, string> = new Map(), // e.g. #attr0 -> attribute
    public expressionAttributeValueMap: Map<string, any> | null = null, // e.g. :val0 -> value
    public expression: string = '',
    public updateExpressionGroup?: 'SET' | 'REMOVE' | 'ADD' | 'DELETE',
  ) { }
}

export enum DynamoDBTransactionMode {
  READ = 'READ',
  WRITE = 'WRITE',
}

export class DynamoDBTransaction {
  private transactGetItems: Exclude<
    TransactGetCommandInput['TransactItems'],
    undefined
  > = [];
  private transactWriteItems: Exclude<
    TransactWriteCommandInput['TransactItems'],
    undefined
  > = [];
  private itemIndxToCheckTTL: Set<number> = new Set();
  private itemIndxToTableKey: Map<number, string> = new Map();

  constructor(
    public mode: DynamoDBTransactionMode,
    private readonly ddbDocClient: DynamoDBDocumentClient,
    private readonly tables: Map<string, DynamoDBTableDefinition>,
    private readonly txRetryLimit: number,
    private readonly txRetryDelay: number,
    private readonly logger: DynamoDBLogger,
    private readonly now: number,
    private returnConsumedCapacity?: ReturnConsumedCapacity,
  ) {
    if (
      mode !== DynamoDBTransactionMode.READ &&
      mode !== DynamoDBTransactionMode.WRITE
    ) {
      throw new Error('Invalid transaction mode');
    }
  }

  async txConflictRetryWrapper(
    command: TransactGetCommand | TransactWriteCommand,
    retries: number,
    delay: number,
  ): Promise<
    TransactWriteCommandOutput | TransactGetCommandOutput | undefined
  > {
    retries = Math.max(1, Math.min(retries, 10)); // Limit retries to a maximum of 10
    delay = Math.max(delay, 50); // Ensure a minimum delay of 50ms
    for (let i = 0; i < retries; i++) {
      try {
        if (command instanceof TransactWriteCommand) {
          return await this.ddbDocClient.send(command);
        } else if (command instanceof TransactGetCommand) {
          return await this.ddbDocClient.send(command);
        }
        throw new Error(
          'Only TransactWriteCommand and TransactGetCommand are supported to retry on conflict',
        );
      } catch (error) {
        if (error instanceof Error && isTransactionConflictError(error)) {
          if (i === retries - 1) {
            throw error;
          }
          this.logger.warn('DynamoDB retrying transaction conflict', { mode: this.mode, attempt: i + 1, maxAttempts: retries, delayMs: delay * (i + 1) });
          await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
        } else {
          throw error;
        }
      }
    }
  }

  _cleanup() {
    this.transactGetItems.length = 0;
    this.transactWriteItems.length = 0;
    this.itemIndxToCheckTTL.clear();
    this.itemIndxToTableKey.clear();
  }

  getOne(
    tableKey: string,
    primaryKey:
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer],
    opts: Pick<DynamoDBFindOptions, 'projectionFields'> = {},
  ) {
    if (this.mode !== DynamoDBTransactionMode.READ) {
      throw new Error('Transaction mode is not READ');
    }

    if (this.transactGetItems.length >= 25) {
      throw new Error('Maximum number of items in a transaction is 25');
    }

    const table = this.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }

    const keys = Array.isArray(primaryKey)
      ? {
        [table.partitionKey]: primaryKey[0],
        [table.sortKey!]: primaryKey[1],
      }
      : {
        [table.partitionKey]: primaryKey,
      };

    let ProjectionExpression: string = '';
    let ExpressionAttributeNames: Record<string, string> | null = null;
    if (opts.projectionFields !== undefined) {
      const projectionFields = [...new Set(opts.projectionFields.map(field => field.includes('.') || field.includes('[') ? field : ucFirst(camel(field))))];
      const optIncludeTimeToLive =
        table.timeToLiveAttribute !== undefined &&
        projectionFields.includes(table.timeToLiveAttribute);
      if (table.timeToLiveAttribute !== undefined && !optIncludeTimeToLive) {
        projectionFields.push(table.timeToLiveAttribute);
      }
      const expressionAttributeNameMap = new Map();
      ProjectionExpression = projectionFields
        .map(field =>
          transformExpressionAttribute(field, expressionAttributeNameMap),
        )
        .join(', ');
      expressionAttributeNameMap.forEach(
        (attributeName, attributeNameVariable) => {
          if (ExpressionAttributeNames === null) {
            ExpressionAttributeNames = {};
          }
          ExpressionAttributeNames[attributeNameVariable] = attributeName;
        },
      );
    }

    this.transactGetItems.push({
      Get: {
        TableName: table.name,
        Key: keys,
        ...(ProjectionExpression !== '' ? { ProjectionExpression } : {}),
        ...(ExpressionAttributeNames !== null
          ? { ExpressionAttributeNames }
          : {}),
      },
    });

    if (table.timeToLiveAttribute !== undefined) {
      this.itemIndxToCheckTTL.add(this.transactGetItems.length - 1);
      this.itemIndxToTableKey.set(this.transactGetItems.length - 1, tableKey);
    }

    return this; // Chainable
  }

  check(
    tableKey: string,
    primaryKey:
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer],
    filter: DynamoDBExpression,
  ) {
    if (this.mode !== DynamoDBTransactionMode.WRITE) {
      throw new Error('Transaction mode is not WRITE');
    }

    if (this.transactWriteItems.length >= 25) {
      throw new Error('Maximum number of items in a transaction is 25');
    }

    const table = this.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }

    if (filter.expression === '') {
      throw new Error('Filter expression is empty');
    }

    const keys = Array.isArray(primaryKey)
      ? {
        [table.partitionKey]: primaryKey[0],
        [table.sortKey!]: primaryKey[1],
      }
      : {
        [table.partitionKey]: primaryKey,
      };

    if (table.timeToLiveAttribute !== undefined) {
      filter = And(
        filter,
        Or(
          AttributeNotExists(table.timeToLiveAttribute),
          MoreThan(table.timeToLiveAttribute, this.now),
        ),
      );
    }

    const ConditionExpression: string = filter.expression;
    const ExpressionAttributeNames: Record<string, string> = Array.from(
      filter.expressionAttributeNameMap,
    ).reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {} as Record<string, any>);
    const ExpressionAttributeValues: Record<string, any> | null =
      filter.expressionAttributeValueMap
        ? Array.from(filter.expressionAttributeValueMap).reduce(
          (acc, [key, value]) => {
            acc[key] = value;
            return acc;
          },
          {} as Record<string, any>,
        )
        : null;

    this.transactWriteItems.push({
      ConditionCheck: {
        TableName: table.name,
        Key: keys,
        ConditionExpression,
        ExpressionAttributeNames,
        ...(ExpressionAttributeValues !== null
          ? { ExpressionAttributeValues }
          : {}),
      },
    });

    return this; // Chainable
  }

  createOne(
    tableKey: string,
    primaryKey:
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer],
    item: Record<string, any>,
    opts: Pick<DynamoDBCreateOptions, 'ttl' | 'onConflict'> = {},
  ) {
    if (this.mode !== DynamoDBTransactionMode.WRITE) {
      throw new Error('Transaction mode is not WRITE');
    }

    if (this.transactWriteItems.length >= 25) {
      throw new Error('Maximum number of items in a transaction is 25');
    }

    const table = this.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }

    const normalizedItem: Record<string, any> = {};
    Object.keys(item).forEach(key => {
      normalizedItem[ucFirst(camel(key))] = item[key];
    });

    if (table.sortKey) {
      if (!Array.isArray(primaryKey) || primaryKey.length !== 2) throw new Error('Composite primary key requires two values');
      normalizedItem[table.partitionKey] = primaryKey[0];
      normalizedItem[table.sortKey!] = primaryKey[1];
    } else {
      normalizedItem[table.partitionKey] = primaryKey;
    }

    if (table.timeToLiveAttribute !== undefined && opts.ttl && opts.ttl > 0) {
      normalizedItem[table.timeToLiveAttribute] = this.now + opts.ttl;
    }

    let ConditionExpression: string = '';
    let ExpressionAttributeNames: Record<string, string> | null = null;
    if (opts.onConflict === 'ignore') {
      const expression = table.sortKey
        ? And(
          AttributeNotExists(table.partitionKey),
          AttributeNotExists(table.sortKey),
        )
        : AttributeNotExists(table.partitionKey);
      ConditionExpression = expression.expression;
      expression.expressionAttributeNameMap.forEach((value, key) => {
        if (!ExpressionAttributeNames) {
          ExpressionAttributeNames = {};
        }
        ExpressionAttributeNames[key] = value;
      });
    }

    this.transactWriteItems.push({
      Put: {
        TableName: table.name,
        Item: normalizedItem,
        ...(ConditionExpression !== '' ? { ConditionExpression } : {}),
        ...(ExpressionAttributeNames !== null
          ? { ExpressionAttributeNames }
          : {}),
      },
    });

    return this; // Chainable
  }

  update(
    tableKey: string,
    primaryKey:
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer],
    commands: DynamoDBExpression[],
    condition: DynamoDBExpression | null = null,
    opts: Pick<DynamoDBUpdateOptions, 'ttl' | 'upsert'> = {},
  ) {
    if (this.mode !== DynamoDBTransactionMode.WRITE) {
      throw new Error('Transaction mode is not WRITE');
    }

    if (this.transactWriteItems.length >= 25) {
      throw new Error('Maximum number of items in a transaction is 25');
    }

    const table = this.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }
    if (commands.length === 0 && opts.ttl === undefined) {
      throw new Error('No update commands provided');
    }

    const keys = Array.isArray(primaryKey)
      ? {
        [table.partitionKey]: primaryKey[0],
        [table.sortKey!]: primaryKey[1],
      }
      : {
        [table.partitionKey]: primaryKey,
      };

    commands = [...commands];
    if (table.timeToLiveAttribute && opts.ttl !== undefined) {
      if (opts.ttl > 0) {
        const expiresAt = this.now + opts.ttl;
        commands.push(Assign(table.timeToLiveAttribute, expiresAt));
      } else if (opts.ttl === 0) {
        commands.push(Remove(table.timeToLiveAttribute));
      }
    }

    const {
      expressionAttributeNameMap,
      expressionAttributeValueMap,
      expression: UpdateExpression,
    } = createUpdateExpression(commands);

    let ConditionExpression: string = '';
    if (table.timeToLiveAttribute && opts.upsert === false) {
      condition = condition
        ? And(
          condition,
          Or(
            AttributeNotExists(table.timeToLiveAttribute),
            MoreThan(table.timeToLiveAttribute, this.now),
          ),
        )
        : Or(
          AttributeNotExists(table.timeToLiveAttribute),
          MoreThan(table.timeToLiveAttribute, this.now),
        );
    }

    if (opts.upsert === false) {
      condition = table.sortKey
        ? condition
          ? And(
            condition,
            And(
              AttributeExists(table.partitionKey),
              AttributeExists(table.sortKey),
            ),
          )
          : And(
            AttributeExists(table.partitionKey),
            AttributeExists(table.sortKey),
          )
        : condition
          ? And(condition, AttributeExists(table.partitionKey))
          : AttributeExists(table.partitionKey);
    }

    if (condition) {
      condition.expressionAttributeNameMap.forEach((value, key) => {
        key = key.replace('#attr', `#condition_attr`);
        expressionAttributeNameMap.set(key, value);
      });
      if (condition.expressionAttributeValueMap) {
        condition.expressionAttributeValueMap.forEach((value, key) => {
          key = key.replace(':val', `:condition_val`);
          expressionAttributeValueMap!.set(key, value);
        });
      }

      ConditionExpression = condition.expression
        .replace(/#attr/g, `#condition_attr`)
        .replace(/:val/g, `:condition_val`);
    }

    let ExpressionAttributeNames: Record<string, string> | null = null;
    let ExpressionAttributeValues: Record<string, any> | null = null;

    expressionAttributeNameMap.forEach(
      (attributeName, attributeNameVariable) => {
        if (!ExpressionAttributeNames) {
          ExpressionAttributeNames = {};
        }
        ExpressionAttributeNames[attributeNameVariable] = attributeName;
      },
    );
    expressionAttributeValueMap!.forEach((value, attributeValueVariable) => {
      if (!ExpressionAttributeValues) {
        ExpressionAttributeValues = {};
      }
      ExpressionAttributeValues[attributeValueVariable] = value;
    });

    this.transactWriteItems.push({
      Update: {
        TableName: table.name,
        Key: keys,
        UpdateExpression,
        ...(ConditionExpression !== '' ? { ConditionExpression } : {}),
        ...(ExpressionAttributeNames !== null
          ? { ExpressionAttributeNames }
          : {}),
        ...(ExpressionAttributeValues !== null
          ? { ExpressionAttributeValues }
          : {}),
      },
    });

    return this; // Chainable
  }

  deleteOne(
    tableKey: string,
    primaryKey:
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer],
    condition: DynamoDBExpression | null = null,
  ) {
    if (this.mode !== DynamoDBTransactionMode.WRITE) {
      throw new Error('Transaction mode is not WRITE');
    }

    if (this.transactWriteItems.length >= 25) {
      throw new Error('Maximum number of items in a transaction is 25');
    }

    const table = this.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }

    const keys = Array.isArray(primaryKey)
      ? {
        [table.partitionKey]: primaryKey[0],
        [table.sortKey!]: primaryKey[1],
      }
      : {
        [table.partitionKey]: primaryKey,
      };

    let ConditionExpression: string = '';
    let ExpressionAttributeNames: Record<string, string> | null = null;
    let ExpressionAttributeValues: Record<string, any> | null = null;

    if (condition) {
      condition.expressionAttributeNameMap.forEach(
        (attributeName, attributeNameVariable) => {
          if (!ExpressionAttributeNames) {
            ExpressionAttributeNames = {};
          }
          ExpressionAttributeNames[attributeNameVariable] = attributeName;
        },
      );
      if (condition.expressionAttributeValueMap) {
        condition.expressionAttributeValueMap.forEach(
          (value, attributeValueVariable) => {
            if (!ExpressionAttributeValues) {
              ExpressionAttributeValues = {};
            }
            ExpressionAttributeValues[attributeValueVariable] = value;
          },
        );
      }
      ConditionExpression = condition.expression;
    }

    this.transactWriteItems.push({
      Delete: {
        TableName: table.name,
        Key: keys,
        ...(ConditionExpression !== '' ? { ConditionExpression } : {}),
        ...(ExpressionAttributeNames !== null
          ? { ExpressionAttributeNames }
          : {}),
        ...(ExpressionAttributeValues !== null
          ? { ExpressionAttributeValues }
          : {}),
      },
    });

    return this; // Chainable
  }

  async commit<T>(camelOrSnake: 'camel' | 'snake' = 'camel'): Promise<DynamoDBTransactionResult<T | null>> {
    let command: TransactGetCommand | TransactWriteCommand;
    const result: DynamoDBTransactionResult<T | null> = {
      numberOfTransactItems: 0,
    };
    this.logger.debug('DynamoDB transaction started', { mode: this.mode, itemCount: this.mode === DynamoDBTransactionMode.READ ? this.transactGetItems.length : this.transactWriteItems.length });
    switch (this.mode) {
      case DynamoDBTransactionMode.READ:
        command = new TransactGetCommand({
          TransactItems: this.transactGetItems,
          ...(this.returnConsumedCapacity
            ? { ReturnConsumedCapacity: this.returnConsumedCapacity }
            : {}),
        });
        const { Responses } = (await this.txConflictRetryWrapper(
          command,
          this.txRetryLimit,
          this.txRetryDelay,
        ).catch((e: Error) => {
          this._cleanup();
          if (isTransactionConflictError(e)) {
            this.logger.error('DynamoDB transaction conflict retry limit reached', { errorName: e.name });
            throw new DynamoDBError(409, {
              message: e.message,
              cause: e,
            });
          } else if (e.name === 'TransactionCanceledException') {
            this.logger.error('DynamoDB transaction canceled', { errorName: e.name });
            throw new DynamoDBError(400, {
              message: e.message,
              cause: e,
            });
          } else {
            this.logger.error('Transaction failed', { errorName: e.name });
            throw new DynamoDBError(500, {
              message: e.message,
              cause: e,
            });
          }
        })) as TransactGetCommandOutput;
        result.numberOfTransactItems = this.transactGetItems.length;
        result.items = Responses!.map(({ Item }, indx) => {
          if (!Item) {
            return null;
          }
          if (this.itemIndxToCheckTTL.has(indx)) {
            const table = this.tables.get(this.itemIndxToTableKey.get(indx)!)!;
            if (
              Item[table.timeToLiveAttribute!] !== undefined &&
              Item[table.timeToLiveAttribute!] <= this.now
            ) {
              return null;
            }
          }
          // Convert keys back to camelCase if camelOrSnake is 'camel' or to snake_case if camelOrSnake is 'snake'
          if (camelOrSnake === 'camel') {
            const newItem: Record<string, any> = {};
            Object.keys(Item!).forEach(key => {
              const value = Item![key];
              newItem[lcFirst(key)] = value;
            });
            return newItem as T;
          } else {
            const newItem: Record<string, any> = {};
            Object.keys(Item!).forEach(key => {
              const value = Item![key];
              newItem[snake(lcFirst(key))] = value;
            });
            return newItem as T;
          }
        });
        this._cleanup();
        break;
      case DynamoDBTransactionMode.WRITE:
        command = new TransactWriteCommand({
          TransactItems: this.transactWriteItems,
          ...(this.returnConsumedCapacity
            ? { ReturnConsumedCapacity: this.returnConsumedCapacity }
            : {}),
        });
        await this.txConflictRetryWrapper(
          command,
          this.txRetryLimit,
          this.txRetryDelay,
        ).catch((e: Error) => {
          this._cleanup();
          if (isTransactionConflictError(e)) {
            this.logger.error('DynamoDB transaction conflict retry limit reached', { errorName: e.name });
            throw new DynamoDBError(409, {
              message: e.message,
              cause: e,
            });
          } else if (e.name === 'TransactionCanceledException') {
            this.logger.error('DynamoDB transaction canceled', { errorName: e.name });
            throw new DynamoDBError(400, {
              message: e.message,
              cause: e,
            });
          } else if (e.name === 'ValidationException') {
            this.logger.error('The request parameters are invalid', { errorName: e.name });
            throw new DynamoDBError(400, {
              message: 'Invalid request parameters',
              cause: e,
            });
          } else {
            this.logger.error('Transaction failed', { errorName: e.name });
            throw new DynamoDBError(500, {
              message: e.message,
              cause: e,
            });
          }
        });
        result.numberOfTransactItems = this.transactWriteItems.length;
        this._cleanup();
        break;
      default:
        throw new Error('Invalid transaction mode');
    }

    this.logger.debug('DynamoDB transaction completed', { mode: this.mode, itemCount: result.numberOfTransactItems });
    return result;
  }
}

export default class DynamoDBService {
  private readonly ddbClient: DynamoDBClient;
  private readonly ddbDocClient: DynamoDBDocumentClient;
  constructor(
    private readonly options: DynamoDBConfig,
    private readonly logger: DynamoDBLogger = silentLogger,
  ) {
    // Check the tables configuration
    if (
      !options.tables ||
      options.tables.size === 0 ||
      Array.from(options.tables.values()).some(table => table.name === '')
    ) {
      throw new Error('DynamoDB tables are not configured properly');
    }

    this.ddbClient = new DynamoDBClient({
      region: options.region,
      credentials: options.credentials,
      requestHandler: {
        requestTimeout: this.options.requestTimeout,
        httpsAgent: new Agent({
          keepAlive: true,
          maxSockets: this.options.maxSockets ?? 50,
        }),
      },
      ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}), // For local development
    });
    this.ddbDocClient = DynamoDBDocumentClient.from(this.ddbClient);
  }

  /** Release connections when the application shuts down; reuse instances in Lambda. */
  destroy(): void { this.ddbClient.destroy(); }

  async getOne<T>(
    tableKey: string,
    primaryKey:
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer],
    opts: Omit<
      DynamoDBFindOptions,
      'cursor' | 'limit' | 'ascending' | 'indexToScan'
    > = {},
    camelOrSnake: 'camel' | 'snake' = 'camel',
  ): Promise<T | null> {
    const table = this.options.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }

    const keys = Array.isArray(primaryKey)
      ? {
        [table.partitionKey]: primaryKey[0],
        [table.sortKey!]: primaryKey[1],
      }
      : {
        [table.partitionKey]: primaryKey,
      };

    let optIncludeTimeToLive: boolean = false;
    let ProjectionExpression: string = '';
    let ExpressionAttributeNames: Record<string, string> | null = null;
    if (opts.projectionFields) {
      const projectionFields = [...new Set(opts.projectionFields.map(field => field.includes('.') || field.includes('[') ? field : ucFirst(camel(field))))];
      optIncludeTimeToLive =
        table.timeToLiveAttribute !== undefined &&
        projectionFields.includes(table.timeToLiveAttribute);
      if (table.timeToLiveAttribute && !optIncludeTimeToLive) {
        projectionFields.push(table.timeToLiveAttribute);
      }
      const expressionAttributeNameMap = new Map();
      ProjectionExpression = projectionFields
        .map(field =>
          transformExpressionAttribute(field, expressionAttributeNameMap),
        )
        .join(', ');
      expressionAttributeNameMap.forEach(
        (attributeName, attributeNameVariable) => {
          if (!ExpressionAttributeNames) {
            ExpressionAttributeNames = {};
          }
          ExpressionAttributeNames[attributeNameVariable] = attributeName;
        },
      );
    }

    this.logger.debug('DynamoDB request started', { operation: 'getOne', tableKey });
    const getCommand = new GetCommand({
      TableName: table.name,
      Key: keys,
      ConsistentRead: opts.consistentRead ?? false,
      ReturnConsumedCapacity:
        opts.returnConsumedCapacity ?? ReturnConsumedCapacity.NONE,
      ...(ProjectionExpression !== '' ? { ProjectionExpression } : {}),
      ...(ExpressionAttributeNames !== null
        ? { ExpressionAttributeNames }
        : {}),
    });

    const { Item: item } = await this.ddbDocClient
      .send(getCommand)
      .catch((e: Error) => {
        if (e.name === 'ValidationException') {
          this.logger.error('The request parameters are invalid', { errorName: e.name, tableKey });
          throw new DynamoDBError(400, {
            message: 'Invalid request parameters',
            cause: e,
          });
        } else {
          this.logger.error('Failed to get item', { errorName: e.name, tableKey });
          throw new DynamoDBError(500, {
            message: 'Failed to get item',
            cause: e,
          });
        }
      });
    // Filter expired item
    if (item && table.timeToLiveAttribute && item[table.timeToLiveAttribute] !== undefined) {
      const now = getUnixTime(new Date());
      if (item[table.timeToLiveAttribute] <= now) {
        this.logger.debug('DynamoDB getOne completed', { tableKey, outcome: 'expired' });
        return null;
      }

      // Delete the time to live attribute from the item if not requested
      if (optIncludeTimeToLive === false) {
        delete item[table.timeToLiveAttribute];
      }
    }
    this.logger.debug('DynamoDB getOne completed', { tableKey, outcome: item ? 'found' : 'not-found' });
    // Item will be undefined if not found
    // Convert keys back to camelCase if camelOrSnake is 'camel' or to snake_case if camelOrSnake is 'snake'
    if (item) {
      if (camelOrSnake === 'camel') {
        const newItem: Record<string, any> = {};
        Object.keys(item).forEach(key => {
          const value = item[key];
          newItem[lcFirst(key)] = value;
        });
        return newItem as T;
      } else {
        const newItem: Record<string, any> = {};
        Object.keys(item).forEach(key => {
          const value = item[key];
          newItem[snake(lcFirst(key))] = value;
        });
        return newItem as T;
      }
    } else {
      return null;
    }
  }

  async getMany<T>(
    tableKey: string,
    primaryKeys: (
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer]
    )[],
    opts: Omit<
      DynamoDBFindOptions,
      'cursor' | 'limit' | 'ascending' | 'indexToScan'
    > = {},
    camelOrSnake: 'camel' | 'snake' = 'camel',
  ): Promise<(T | null)[]> {
    const table = this.options.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }

    const pkIndexMap: Map<string, number> = new Map();
    const keys = primaryKeys.map((primaryKey, indx) => {
      const isArrayOfKeys = Array.isArray(primaryKey);
      const pkStr = serializeKey(primaryKey);

      if (pkIndexMap.has(pkStr)) {
        throw new Error(`Duplicate primary key: ${pkStr}`);
      }
      pkIndexMap.set(pkStr, indx);
      return isArrayOfKeys
        ? {
          [table.partitionKey]: primaryKey[0],
          [table.sortKey!]: primaryKey[1],
        }
        : {
          [table.partitionKey]: primaryKey,
        };
    });

    let optIncludeTimeToLive: boolean = false;
    let optIncludePartitionKey: boolean = true;
    let optIncludeSortKey: boolean = true;
    let ProjectionExpression: string = '';
    let ExpressionAttributeNames: Record<string, string> | null = null;
    if (opts.projectionFields) {
      const projectionFields = [...new Set(opts.projectionFields.map(field => field.includes('.') || field.includes('[') ? field : ucFirst(camel(field))))];
      optIncludeTimeToLive =
        table.timeToLiveAttribute !== undefined &&
        projectionFields.includes(table.timeToLiveAttribute);
      if (table.timeToLiveAttribute && !optIncludeTimeToLive) {
        projectionFields.push(table.timeToLiveAttribute);
      }
      // To help parse the response by item, include the primary key values for the items in your request in the ProjectionExpression parameter.
      optIncludePartitionKey = projectionFields.includes(
        table.partitionKey,
      );
      if (!optIncludePartitionKey) {
        projectionFields.push(table.partitionKey);
      }
      optIncludeSortKey =
        table.sortKey !== undefined &&
        projectionFields.includes(table.sortKey);
      if (table.sortKey && !optIncludeSortKey) {
        projectionFields.push(table.sortKey);
      }

      const expressionAttributeNameMap = new Map();
      ProjectionExpression = projectionFields
        .map(field =>
          transformExpressionAttribute(field, expressionAttributeNameMap),
        )
        .join(', ');
      expressionAttributeNameMap.forEach(
        (attributeName, attributeNameVariable) => {
          if (!ExpressionAttributeNames) {
            ExpressionAttributeNames = {};
          }
          ExpressionAttributeNames[attributeNameVariable] = attributeName;
        },
      );
    }

    const results = new Array(primaryKeys.length).fill(null);
    const now = getUnixTime(new Date());
    let unprocessedAttempt = 0;
    while (keys.length > 0) {
      const batch = keys.splice(0, 100);
      this.logger.debug('DynamoDB batch request started', { operation: 'getMany', tableKey, itemCount: batch.length });
      const batchGetCommand = new BatchGetCommand({
        RequestItems: {
          [table.name]: {
            Keys: batch,
            ConsistentRead: opts.consistentRead ?? false,
            ...(ProjectionExpression !== '' ? { ProjectionExpression } : {}),
            ...(ExpressionAttributeNames !== null
              ? { ExpressionAttributeNames }
              : {}),
          },
        },
        ReturnConsumedCapacity:
          opts.returnConsumedCapacity ?? ReturnConsumedCapacity.NONE,
      });

      const { Responses: responses, UnprocessedKeys: rawUnprocessedKeys } =
        await this.ddbDocClient.send(batchGetCommand).catch((error: Error) => {
          this.logger.error('Failed to get items', { tableKey, errorName: error.name });
          throw error;
        });
      const items =
        responses && responses[table.name] ? responses[table.name] : [];
      const unprocessedKeys =
        (rawUnprocessedKeys && rawUnprocessedKeys[table.name]?.Keys) || [];

      if (unprocessedKeys.length > 0) {
        if (unprocessedAttempt >= MAX_UNPROCESSED_ATTEMPTS) {
          this.logger.error('DynamoDB batch retry limit reached', { operation: 'getMany', tableKey, retryCount: unprocessedAttempt });
          throw new DynamoDBError(500, {
            message: 'Failed to retrieve items after multiple attempts',
            cause: new Error('Too many unprocessed items'),
          });
        }
        const delayMs = backoffDelayMs(unprocessedAttempt);
        this.logger.warn('DynamoDB retrying unprocessed batch items', { operation: 'getMany', tableKey, itemCount: unprocessedKeys.length, attempt: unprocessedAttempt + 1, delayMs });
        await sleep(delayMs);
        unprocessedAttempt += 1;
      } else {
        unprocessedAttempt = 0;
      }
      keys.push(...unprocessedKeys);

      // Filter expired items
      items?.forEach(item => {
        if (
          item &&
          table.timeToLiveAttribute &&
          item[table.timeToLiveAttribute] !== undefined
        ) {
          if (item[table.timeToLiveAttribute] <= now) {
            return;
          }
          // Delete the time to live attribute from the item if not requested
          if (optIncludeTimeToLive === false) {
            delete item[table.timeToLiveAttribute];
          }
        }

        const pkStr = serializeKey(table.sortKey
          ? [item[table.partitionKey], item[table.sortKey]]
          : item[table.partitionKey]);

        //  Delete the primary key values from the item if not requested
        if (optIncludePartitionKey === false) {
          delete item[table.partitionKey];
        }
        if (optIncludeSortKey === false && table.sortKey) {
          delete item[table.sortKey];
        }

        // Convert keys back to camelCase if camelOrSnake is 'camel' or to snake_case if camelOrSnake is 'snake'
        if (camelOrSnake === 'camel') {
          const newItem: Record<string, any> = {};
          Object.keys(item).forEach(key => {
            const value = item[key];
            newItem[lcFirst(key)] = value;
          });
          results[pkIndexMap.get(pkStr)!] = newItem as T;
        } else {
          const newItem: Record<string, any> = {};
          Object.keys(item).forEach(key => {
            const value = item[key];
            newItem[snake(lcFirst(key))] = value;
          });
          results[pkIndexMap.get(pkStr)!] = newItem as T;
        }
      });
    }

    this.logger.debug('DynamoDB getMany completed', { tableKey, requestedCount: primaryKeys.length, returnedCount: results.filter(item => item !== null).length });
    return results;
  }

  async find<T>(
    tableKey: string,
    keyCondition:
      | DynamoDBExpression
      | [string | number | Buffer]
      | [
        string | number | Buffer,
        (
          | string
          | number
          | Buffer
          | ['BETWEEN', [string | number | Buffer, string | number | Buffer]]
        ),
      ]
      | [
        string | number | Buffer,
        string | number | Buffer | ['begins_with', string],
      ],
    filter: DynamoDBExpression | null = null,
    opts: DynamoDBFindOptions = {},
    camelOrSnake: 'camel' | 'snake' = 'camel',
  ) {
    const table = this.options.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }

    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) throw new Error('Limit must be a positive integer');
    let indexInUse: 'GSI' | 'LSI' | null = null;
    let indexToScan: DynamoDBLSIConfig | DynamoDBGSIConfig | null = null;
    // Check the index existence and determine the index type if index name is provided
    if (opts.indexToScan !== undefined) {
      indexToScan =
        table.globalSecondaryIndexes?.find(
          gsi => gsi.indexName === opts.indexToScan,
        ) ||
        table.localSecondaryIndexes?.find(
          lsi => lsi.indexName === opts.indexToScan,
        ) ||
        null;
      if (!indexToScan) {
        throw new Error(
          `Index ${opts.indexToScan} not found in table ${tableKey}`,
        );
      }

      // Only GSI has partitionKey attribute
      if (indexToScan.hasOwnProperty('partitionKey')) {
        indexInUse = 'GSI';
      } else {
        indexInUse = 'LSI';
      }
    }
    let keyConditionExp: DynamoDBExpression | null = null;
    if (Array.isArray(keyCondition)) {
      if (!keyCondition.length || keyCondition.length > 2) {
        throw new Error('Invalid key condition array length');
      }

      switch (indexInUse) {
        case 'LSI':
          if (keyCondition.length !== 2) {
            throw new Error(
              'For LSI, key condition must include both partition key and sort key conditions',
            );
          }
          break;
        case 'GSI':
          if (
            keyCondition.length === 2 &&
            (indexToScan as DynamoDBGSIConfig).sortKey === undefined
          ) {
            throw new Error(
              'For GSI without sort key, key condition must only include partition key condition',
            );
          }
          break;
        case null:
          if (keyCondition.length === 2 && table.sortKey === undefined) {
            throw new Error(
              'For table without sort key, key condition must only include partition key condition',
            );
          }
          break;
      }

      // If using LSI or no index, the partition key condition expression should be on the table partition key. If using GSI, the partition key condition expression should be on the GSI partition key
      const partitionKeyKeyConditionExpression: DynamoDBExpression = Equal(
        indexInUse === 'LSI' || indexInUse === null
          ? table.partitionKey
          : (indexToScan as DynamoDBGSIConfig).partitionKey,
        keyCondition[0],
      );

      if (keyCondition.length === 2) {
        let sortKeyKeyConditionExpression: DynamoDBExpression;
        if (Array.isArray(keyCondition[1])) {
          switch (keyCondition[1][0]) {
            case 'BETWEEN':
              sortKeyKeyConditionExpression = Between(
                indexInUse === null
                  ? table.sortKey!
                  : indexInUse === 'LSI'
                    ? (indexToScan as DynamoDBLSIConfig).sortKey
                    : (indexToScan as DynamoDBGSIConfig).sortKey!,
                keyCondition[1][1][0],
                keyCondition[1][1][1],
              );
              break;
            case 'begins_with':
              sortKeyKeyConditionExpression = BeginsWith(
                indexInUse === null
                  ? table.sortKey!
                  : indexInUse === 'LSI'
                    ? (indexToScan as DynamoDBLSIConfig).sortKey
                    : (indexToScan as DynamoDBGSIConfig).sortKey!,
                keyCondition[1][1],
              );
              break;
            default:
              throw new Error('Invalid sort key condition');
          }
        } else {
          sortKeyKeyConditionExpression = Equal(
            indexInUse === null
              ? table.sortKey!
              : indexInUse === 'LSI'
                ? (indexToScan as DynamoDBLSIConfig).sortKey
                : (indexToScan as DynamoDBGSIConfig).sortKey!,
            keyCondition[1],
          );
        }

        keyConditionExp = And(
          partitionKeyKeyConditionExpression,
          sortKeyKeyConditionExpression,
        );
      } else {
        keyConditionExp = partitionKeyKeyConditionExpression;
      }
    } else if (keyCondition instanceof DynamoDBExpression) {
      keyConditionExp = keyCondition;
    } else {
      throw new Error('Invalid key condition');
    }

    const expressionAttributeNameMap = new Map(keyConditionExp.expressionAttributeNameMap);
    const expressionAttributeValueMap = new Map(keyConditionExp.expressionAttributeValueMap);
    const KeyConditionExpression = keyConditionExp.expression;

    let FilterExpression: string = '';
    if (filter) {
      filter.expressionAttributeNameMap.forEach((value, key) => {
        key = key.replace('#attr', `#filter_attr`);
        expressionAttributeNameMap.set(key, value);
      });
      if (filter.expressionAttributeValueMap) {
        filter.expressionAttributeValueMap.forEach((value, key) => {
          key = key.replace(':val', `:filter_val`);
          expressionAttributeValueMap!.set(key, value); // partitionKeyKeyConditionExpression decides the attribute value map is not null
        });
      }

      FilterExpression = filter.expression
        .replace(/#attr/g, `#filter_attr`)
        .replace(/:val/g, `:filter_val`);
    }

    let optIncludeTimeToLive: boolean = false;
    let optIncludePartitionKey: boolean = true;
    let optIncludeSortKey: boolean = true;
    let ProjectionExpression: string = '';
    let ExpressionAttributeNames: Record<string, string> | null = null;
    let ExpressionAttributeValues: Record<string, any> | null = null;
    const now = getUnixTime(new Date());

    if (opts.projectionFields) {
      const projectionFields = [...new Set(opts.projectionFields.map(field => field.includes('.') || field.includes('[') ? field : ucFirst(camel(field))))];
      optIncludeTimeToLive =
        table.timeToLiveAttribute !== undefined &&
        projectionFields.includes(table.timeToLiveAttribute);
      if (table.timeToLiveAttribute !== undefined && !optIncludeTimeToLive) {
        projectionFields.push(table.timeToLiveAttribute);
      }

      if (indexInUse !== null) {
        for (const key of [table.partitionKey, table.sortKey]) {
          if (key && !projectionFields.includes(key)) projectionFields.push(key);
        }
      }
      // Validate the projection fields with the index in use if any
      // If the table has time to live attribute, personally insist to include that attribute in GSI or LSI projection.
      switch (indexInUse) {
        case 'LSI':
          let hasFieldNotInsideLSIProjection: boolean = false;
          if (
            (indexToScan as DynamoDBLSIConfig).projectionType === 'KEYS_ONLY'
          ) {
            hasFieldNotInsideLSIProjection =
              diff(projectionFields, [
                table.partitionKey,
                (indexToScan as DynamoDBLSIConfig).sortKey,
              ]).length > 0;
          } else if (
            (indexToScan as DynamoDBLSIConfig).projectionType === 'INCLUDE'
          ) {
            hasFieldNotInsideLSIProjection =
              diff(projectionFields, [
                table.partitionKey,
                (indexToScan as DynamoDBLSIConfig).sortKey,
                ...(indexToScan as DynamoDBLSIConfig).nonKeyAttributes!,
              ]).length > 0;
          }
          if (hasFieldNotInsideLSIProjection) {
            this.logger.warn(
              'Some of the projection fields are not included in the LSI projection, which may cause additional read cost',
              {
                tableKey,
                indexName: (indexToScan as DynamoDBLSIConfig).indexName,
                projectionType: (indexToScan as DynamoDBLSIConfig)
                  .projectionType,
              },
            );
          }
          break;
        case 'GSI':
          let hasFieldNotInsideGSIProjection: boolean = false;
          if (
            (indexToScan as DynamoDBGSIConfig).projectionType === 'KEYS_ONLY'
          ) {
            hasFieldNotInsideGSIProjection =
              diff(projectionFields, [
                table.partitionKey,
                ...(table.sortKey ? [table.sortKey] : []),
                (indexToScan as DynamoDBGSIConfig).partitionKey,
                ...((indexToScan as DynamoDBGSIConfig).sortKey !== undefined
                  ? [(indexToScan as DynamoDBGSIConfig).sortKey]
                  : []),
              ]).length > 0;
          } else if (
            (indexToScan as DynamoDBGSIConfig).projectionType === 'INCLUDE'
          ) {
            hasFieldNotInsideGSIProjection =
              diff(projectionFields, [
                table.partitionKey,
                ...(table.sortKey ? [table.sortKey] : []),
                (indexToScan as DynamoDBGSIConfig).partitionKey,
                ...((indexToScan as DynamoDBGSIConfig).sortKey !== undefined
                  ? [(indexToScan as DynamoDBGSIConfig).sortKey]
                  : []),
                ...(indexToScan as DynamoDBGSIConfig).nonKeyAttributes!,
              ]).length > 0;
          }
          if (hasFieldNotInsideGSIProjection) {
            this.logger.error(
              'Some of the projection fields are not included in the GSI projection, so the query cannot be executed',
              {
                tableKey,
                indexName: (indexToScan as DynamoDBGSIConfig).indexName,
                projectionType: (indexToScan as DynamoDBGSIConfig)
                  .projectionType,
              },
            );
            throw new Error(
              'All projection fields must be included in the GSI projection',
            );
          }
          break;
      }
      // To help parse the response by item, include the primary key values for the items in your request in the ProjectionExpression parameter.
      optIncludePartitionKey = projectionFields.includes(
        indexInUse === null
          ? table.partitionKey
          : indexInUse === 'LSI'
            ? table.partitionKey
            : (indexToScan as DynamoDBGSIConfig).partitionKey,
      );
      if (!optIncludePartitionKey) {
        projectionFields.push(
          indexInUse === null
            ? table.partitionKey
            : indexInUse === 'LSI'
              ? table.partitionKey
              : (indexToScan as DynamoDBGSIConfig).partitionKey,
        );
      }
      optIncludeSortKey =
        (indexInUse === null &&
          table.sortKey !== undefined &&
          projectionFields.includes(table.sortKey)) ||
        (indexInUse === 'LSI' &&
          projectionFields.includes(
            (indexToScan as DynamoDBLSIConfig).sortKey,
          )) ||
        (indexInUse === 'GSI' &&
          (indexToScan as DynamoDBGSIConfig).sortKey !== undefined &&
          projectionFields.includes(
            (indexToScan as DynamoDBGSIConfig).sortKey!,
          ));
      if (
        indexInUse === null &&
        table.sortKey !== undefined &&
        !optIncludeSortKey
      ) {
        projectionFields.push(table.sortKey);
      } else if (indexInUse === 'LSI' && !optIncludeSortKey) {
        projectionFields.push((indexToScan as DynamoDBLSIConfig).sortKey);
      } else if (
        indexInUse === 'GSI' &&
        (indexToScan as DynamoDBGSIConfig).sortKey !== undefined &&
        !optIncludeSortKey
      ) {
        projectionFields.push((indexToScan as DynamoDBGSIConfig).sortKey!);
      }

      ProjectionExpression = projectionFields
        .map(field =>
          transformExpressionAttribute(
            field,
            expressionAttributeNameMap,
            '#proj_attr',
          ),
        )
        .join(', ');
    }

    expressionAttributeNameMap.forEach(
      (attributeName, attributeNameVariable) => {
        if (!ExpressionAttributeNames) {
          ExpressionAttributeNames = {};
        }
        ExpressionAttributeNames[attributeNameVariable] = attributeName;
      },
    );
    expressionAttributeValueMap!.forEach((value, attributeValueVariable) => {
      if (!ExpressionAttributeValues) {
        ExpressionAttributeValues = {};
      }
      ExpressionAttributeValues[attributeValueVariable] = value;
    });

    const numOfNeededItems = opts.limit; // May be undefined then no limit
    const result: DynamoDBFindResult<T> = {
      items: [],
    };

    if (opts.cursor !== undefined && !(typeof opts.cursor === 'object' && !Array.isArray(opts.cursor) && !Buffer.isBuffer(opts.cursor))) {
      // Validate cursor has correct number of elements based on context
      const needsTwoElements =
        (indexInUse === null && table.sortKey !== undefined) ||
        indexInUse === 'LSI' ||
        (indexInUse === 'GSI' &&
          (indexToScan as DynamoDBGSIConfig).sortKey !== undefined);
      if (Array.isArray(opts.cursor)) {
        if (opts.cursor.length !== 2 || !needsTwoElements) {
          throw new Error('Cursor array cannot have more than 2 elements');
        }
      } else {
        if (needsTwoElements) {
          throw new Error(
            'Cursor array must have exactly 2 elements for composite key tables/indexes',
          );
        }
      }
    }

    const params: QueryCommandInput = {
      TableName: table.name,
      KeyConditionExpression,
      ...(indexToScan !== null ? { IndexName: indexToScan.indexName } : {}),
      ...(FilterExpression !== '' ? { FilterExpression } : {}),
      ...(ExpressionAttributeNames ? { ExpressionAttributeNames } : {}),
      ...(ExpressionAttributeValues ? { ExpressionAttributeValues } : {}),
      ConsistentRead:
        (opts.consistentRead ?? false) &&
        (indexInUse === null || indexInUse === 'LSI'),
      ReturnConsumedCapacity:
        opts.returnConsumedCapacity ?? ReturnConsumedCapacity.NONE,
      ...(ProjectionExpression ? { ProjectionExpression } : {}),
      ScanIndexForward: opts.ascending ?? true,
      ...(opts.cursor !== undefined
        ? {
          ExclusiveStartKey: typeof opts.cursor === 'object' && !Array.isArray(opts.cursor) && !Buffer.isBuffer(opts.cursor)
            ? opts.cursor
            : Array.isArray(opts.cursor)
            ? {
              [indexInUse === null
                ? table.partitionKey
                : indexInUse === 'LSI'
                  ? table.partitionKey
                  : (indexToScan as DynamoDBGSIConfig).partitionKey]:
                opts.cursor[0],
              [indexInUse === null
                ? table.sortKey!
                : indexInUse === 'LSI'
                  ? (indexToScan as DynamoDBLSIConfig).sortKey
                  : (indexToScan as DynamoDBGSIConfig).sortKey!]:
                opts.cursor[1],
            }
            : {
              [indexInUse === null
                ? table.partitionKey
                : indexInUse === 'LSI'
                  ? table.partitionKey
                  : (indexToScan as DynamoDBGSIConfig).partitionKey]:
                opts.cursor,
            },
        }
        : {}),
    };

    while (true) {
      this.logger.debug('DynamoDB query page requested', { tableKey, hasCursor: !!params.ExclusiveStartKey, hasFilter: !!params.FilterExpression });
      const { Items, LastEvaluatedKey } = await this.ddbDocClient
        .send(new QueryCommand(params))
        .catch((e: Error) => {
          if (e.name === 'ValidationException') {
            this.logger.error('The request parameters are invalid', { errorName: e.name, tableKey });
            throw new DynamoDBError(400, {
              message: 'Invalid request parameters',
              cause: e,
            });
          }
          this.logger.error('Failed to query items', { errorName: e.name, tableKey });
          throw new DynamoDBError(500, {
            message: 'Failed to query items',
            cause: e,
          });
        });

      this.logger.debug('DynamoDB query page received', { tableKey, itemCount: Items?.length ?? 0, hasMore: !!LastEvaluatedKey });
      if (LastEvaluatedKey) {
        params.ExclusiveStartKey = LastEvaluatedKey;
      }

      // Filter expired items
      let hasRemainsInCurrentBatch = false;
      Items?.forEach(item => {
        if (
          item &&
          table.timeToLiveAttribute &&
          item[table.timeToLiveAttribute] !== undefined
        ) {
          if (item[table.timeToLiveAttribute] <= now) {
            return;
          }
          // Delete the time to live attribute from the item if not requested
          if (optIncludeTimeToLive === false) {
            delete item[table.timeToLiveAttribute];
          }
        }

        // After filtering, check if any remaining item in the current batch when reaching the limit
        if (numOfNeededItems && result.items.length === numOfNeededItems) {
          hasRemainsInCurrentBatch = true;
          return;
        }

        if (numOfNeededItems && result.items.length + 1 === numOfNeededItems) {
          // The last item to reach the limit
          // Set the cursor to the last item for next query
          if (indexInUse === null) {
            result.cursor =
              table.sortKey !== undefined
                ? [item[table.partitionKey], item[table.sortKey]]
                : item[table.partitionKey];
          } else {
            result.cursor = Object.fromEntries(
              [table.partitionKey, table.sortKey, (indexToScan as DynamoDBGSIConfig).partitionKey, indexToScan!.sortKey]
                .filter((key): key is string => key !== undefined)
                .map(key => [key, item[key]]),
            );
          }
        }

        if (optIncludePartitionKey === false) {
          // Delete the primary key values from the item if not requested
          switch (indexInUse) {
            case null:
              delete item[table.partitionKey];
              break;
            case 'LSI':
              delete item[table.partitionKey];
              break;
            case 'GSI':
              delete item[(indexToScan as DynamoDBGSIConfig).partitionKey];
              break;
          }
        }
        if (optIncludeSortKey === false) {
          // Delete the sort key value from the item if not requested
          switch (indexInUse) {
            case null:
              if (table.sortKey !== undefined) {
                delete item[table.sortKey];
              }
              break;
            case 'LSI':
              delete item[(indexToScan as DynamoDBLSIConfig).sortKey];
              break;
            case 'GSI':
              if ((indexToScan as DynamoDBGSIConfig).sortKey !== undefined) {
                delete item[(indexToScan as DynamoDBGSIConfig).sortKey!];
              }
              break;
          }
        }

        if (indexInUse !== null && opts.projectionFields) {
          for (const key of [table.partitionKey, table.sortKey]) {
            if (key && !opts.projectionFields.some(field => ucFirst(camel(field)) === key)) delete item[key];
          }
        }
        // Convert keys back to camelCase if camelOrSnake is 'camel' or to snake_case if camelOrSnake is 'snake'
        if (camelOrSnake === 'camel') {
          const newItem: Record<string, any> = {};
          Object.keys(item).forEach(key => {
            const value = item[key];
            newItem[lcFirst(key)] = value;
          });
          result.items.push(newItem as T);
        } else {
          const newItem: Record<string, any> = {};
          Object.keys(item).forEach(key => {
            const value = item[key];
            newItem[snake(lcFirst(key))] = value;
          });
          result.items.push(newItem as T);
        }
      });

      if (numOfNeededItems && result.items.length === numOfNeededItems) {
        if (!hasRemainsInCurrentBatch && !LastEvaluatedKey) {
          delete result.cursor; // No more items for next query and also no remains in the last batch
        }
        break;
      } else if (!LastEvaluatedKey) {
        if (!hasRemainsInCurrentBatch) {
          delete result.cursor; // No more items for next query and also no remains in the last batch
        }
        break;
      }
    }

    return result;
  }

  async createOne(
    tableKey: string,
    primaryKey:
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer],
    item: Record<string, any>,
    opts: DynamoDBCreateOptions = {},
    camelOrSnake: 'camel' | 'snake' = 'camel',
  ): Promise<DynamoDBCreateOneResult> {
    const table = this.options.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }
    const normalizedItem: Record<string, any> = {};
    Object.keys(item).forEach(key => {
      normalizedItem[ucFirst(camel(key))] = item[key];
    });

    if (table.sortKey) {
      if (!Array.isArray(primaryKey) || primaryKey.length !== 2) throw new Error('Composite primary key requires two values');
      normalizedItem[table.partitionKey] = primaryKey[0];
      normalizedItem[table.sortKey] = primaryKey[1];
    } else {
      normalizedItem[table.partitionKey] = primaryKey;
    }

    const now = getUnixTime(new Date());
    if (table.timeToLiveAttribute && opts.ttl && opts.ttl > 0) {
      normalizedItem[table.timeToLiveAttribute] = now + opts.ttl;
    }

    let ConditionExpression: string = '';
    let ExpressionAttributeNames: Record<string, string> | null = null;
    if (opts.onConflict === 'ignore') {
      const expression = table.sortKey
        ? And(
          AttributeNotExists(table.partitionKey),
          AttributeNotExists(table.sortKey),
        )
        : AttributeNotExists(table.partitionKey);
      ConditionExpression = expression.expression;
      expression.expressionAttributeNameMap.forEach((value, key) => {
        if (!ExpressionAttributeNames) {
          ExpressionAttributeNames = {};
        }
        ExpressionAttributeNames[key] = value;
      });
    }

    this.logger.debug('DynamoDB request started', { operation: 'createOne', tableKey });
    const putCommand = new PutCommand({
      TableName: table.name,
      Item: normalizedItem,
      ...(ConditionExpression !== '' ? { ConditionExpression } : {}),
      ...(ExpressionAttributeNames !== null
        ? { ExpressionAttributeNames }
        : {}),
      ReturnConsumedCapacity:
        opts.returnConsumedCapacity ?? ReturnConsumedCapacity.NONE,
      ReturnValues: opts.onConflict === 'ignore' ? 'NONE' : 'ALL_OLD',
    });

    const result: DynamoDBCreateOneResult = {
      created: true,
    };

    try {
      const { Attributes: replacedItem } =
        await this.ddbDocClient.send(putCommand);

      if (
        table.timeToLiveAttribute &&
        normalizedItem[table.timeToLiveAttribute]
      ) {
        result.expiresAt = normalizedItem[table.timeToLiveAttribute];
      }

      if (opts.onConflict !== 'ignore' && replacedItem !== undefined) {
        // Only not expired item will be considered as replaced item
        if (
          !(
            table.timeToLiveAttribute &&
            replacedItem[table.timeToLiveAttribute] &&
            replacedItem[table.timeToLiveAttribute] <= now
          )
        ) {
          result.created = false;
          if (table.timeToLiveAttribute) {
            delete replacedItem[table.timeToLiveAttribute]; // Delete the time to live attribute from the item
          }
          // Convert keys back to camelCase if camelOrSnake is 'camel' or to snake_case if camelOrSnake is 'snake'
          if (camelOrSnake === 'camel') {
            const newItem: Record<string, any> = {};
            Object.keys(replacedItem).forEach(key => {
              const value = replacedItem[key];
              newItem[lcFirst(key)] = value;
            });
            result.replacedItem = newItem as Record<string, any>;
          } else {
            const newItem: Record<string, any> = {};
            Object.keys(replacedItem).forEach(key => {
              const value = replacedItem[key];
              newItem[snake(lcFirst(key))] = value;
            });
            result.replacedItem = newItem as Record<string, any>;
          }
        }
      }
    } catch (e: any) {
      const error = e as Error;
      if (
        error.name === 'ConditionalCheckFailedException' &&
        opts.onConflict === 'ignore'
      ) {
        this.logger.debug('DynamoDB create skipped: item already exists', { tableKey });
        result.created = false;
      } else {
        this.logger.error('Failed to create item', { errorName: error.name, tableKey });
        throw new DynamoDBError(500, {
          message: 'Failed to create item',
          cause: error,
        });
      }
    }

    this.logger.debug('DynamoDB createOne completed', { tableKey, created: result.created });
    return result;
  }

  async createMany(
    tableKey: string,
    primaryKeys: (
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer]
    )[],
    items: Record<string, any>[],
    opts: Omit<DynamoDBCreateOptions, 'onConflict'> = {},
  ): Promise<DynamoDBCreateManyResult> {
    const table = this.options.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }

    if (items.length === 0 || primaryKeys.length === 0) {
      throw new Error('No items to create');
    }

    if (primaryKeys.length !== items.length) {
      throw new Error('Primary keys and items length mismatch');
    }

    const now = getUnixTime(new Date());
    const normalizedItems = items.map((item, indx) => {
      const normalizedItem: Record<string, any> = {};
      Object.keys(item).forEach(key => {
        normalizedItem[ucFirst(camel(key))] = item[key];
      });

      const primaryKey = primaryKeys[indx];
      if (table.sortKey) {
        if (!Array.isArray(primaryKey) || primaryKey.length !== 2) throw new Error('Composite primary key requires two values');
        normalizedItem[table.partitionKey] = primaryKey![0];
        normalizedItem[table.sortKey] = primaryKey![1];
      } else {
        normalizedItem[table.partitionKey] = primaryKey;
      }

      if (table.timeToLiveAttribute && opts.ttl && opts.ttl > 0) {
        normalizedItem[table.timeToLiveAttribute] = now + opts.ttl;
      }

      return normalizedItem;
    });

    const result: DynamoDBCreateManyResult = {
      numberOfItems: normalizedItems.length,
    };

    if (
      table.timeToLiveAttribute &&
      normalizedItems[0][table.timeToLiveAttribute]
    ) {
      result.expiresAt = normalizedItems[0][table.timeToLiveAttribute];
    }

    let unprocessedAttempt = 0;
    while (normalizedItems.length > 0) {
      const batch = normalizedItems.splice(0, 25);

      this.logger.debug('DynamoDB batch request started', { operation: 'createMany', tableKey, itemCount: batch.length });
      const batchWriteCommand = new BatchWriteCommand({
        RequestItems: {
          [table.name]: batch.map(item => ({
            PutRequest: {
              Item: item,
            },
          })),
        },
        ReturnConsumedCapacity:
          opts.returnConsumedCapacity ?? ReturnConsumedCapacity.NONE,
      });

      const { UnprocessedItems } = await this.ddbDocClient
        .send(batchWriteCommand)
        .catch((e: Error) => {
          this.logger.error('Failed to create items', { errorName: e.name, tableKey });
          throw new DynamoDBError(500, {
            message: 'Failed to create items',
            cause: e,
          });
        });

      const unprocessedItems = UnprocessedItems?.[table.name];
      if (unprocessedItems !== undefined && unprocessedItems.length > 0) {
        if (unprocessedAttempt >= MAX_UNPROCESSED_ATTEMPTS) {
          this.logger.error('DynamoDB batch retry limit reached', { operation: 'createMany', tableKey, retryCount: unprocessedAttempt });
          throw new DynamoDBError(500, {
            message: 'Failed to create items after multiple attempts',
            cause: new Error('Too many unprocessed items'),
          });
        }
        const delayMs = backoffDelayMs(unprocessedAttempt);
        this.logger.warn('DynamoDB retrying unprocessed batch items', { operation: 'createMany', tableKey, itemCount: unprocessedItems.length, attempt: unprocessedAttempt + 1, delayMs });
        await sleep(delayMs);
        unprocessedAttempt += 1;
        normalizedItems.push(
          ...(unprocessedItems
            .map(item => item.PutRequest?.Item)
            .filter(item => item !== undefined) as Record<string, any>[]),
        );
      } else {
        unprocessedAttempt = 0;
      }
    }

    this.logger.debug('DynamoDB createMany completed', { tableKey, itemCount: result.numberOfItems });
    return result;
  }

  async update<T>(
    tableKey: string,
    primaryKey:
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer],
    commands: DynamoDBExpression[],
    condition: DynamoDBExpression | null = null,
    opts: DynamoDBUpdateOptions = {},
    camelOrSnake: 'camel' | 'snake' = 'camel',
  ): Promise<DynamoDBUpdateResult<T>> {
    const table = this.options.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }
    if (commands.length === 0) {
      throw new Error('No update commands provided');
    }

    const keys = Array.isArray(primaryKey)
      ? {
        [table.partitionKey]: primaryKey[0],
        [table.sortKey!]: primaryKey[1],
      }
      : {
        [table.partitionKey]: primaryKey,
      };

    commands = [...commands];
    const now = getUnixTime(new Date());
    let expiresAt: number = 0;
    if (table.timeToLiveAttribute && opts.ttl !== undefined) {
      if (opts.ttl > 0) {
        expiresAt = now + opts.ttl;
        commands.push(Assign(table.timeToLiveAttribute, expiresAt));
      } else if (opts.ttl === 0) {
        commands.push(Remove(table.timeToLiveAttribute));
      }
    }

    const {
      expressionAttributeNameMap,
      expressionAttributeValueMap,
      expression: UpdateExpression,
    } = createUpdateExpression(commands);

    let ConditionExpression: string = '';
    if (table.timeToLiveAttribute && opts.upsert === false) {
      condition = condition
        ? And(
          condition,
          Or(
            AttributeNotExists(table.timeToLiveAttribute),
            MoreThan(table.timeToLiveAttribute, now),
          ),
        )
        : Or(
          AttributeNotExists(table.timeToLiveAttribute),
          MoreThan(table.timeToLiveAttribute, now),
        );
    }

    if (opts.upsert === false) {
      condition = table.sortKey
        ? condition
          ? And(
            condition,
            And(
              AttributeExists(table.partitionKey),
              AttributeExists(table.sortKey),
            ),
          )
          : And(
            AttributeExists(table.partitionKey),
            AttributeExists(table.sortKey),
          )
        : condition
          ? And(condition, AttributeExists(table.partitionKey))
          : AttributeExists(table.partitionKey);
    }

    if (condition) {
      condition.expressionAttributeNameMap.forEach((value, key) => {
        key = key.replace('#attr', `#condition_attr`);
        expressionAttributeNameMap.set(key, value);
      });
      if (condition.expressionAttributeValueMap) {
        condition.expressionAttributeValueMap.forEach((value, key) => {
          key = key.replace(':val', `:condition_val`);
          expressionAttributeValueMap!.set(key, value); // createUpdateExpression decides the attribute value map is not null
        });
      }

      ConditionExpression = condition.expression
        .replace(/#attr/g, `#condition_attr`)
        .replace(/:val/g, `:condition_val`);
    }

    let ExpressionAttributeNames: Record<string, string> | null = null;
    let ExpressionAttributeValues: Record<string, any> | null = null;

    expressionAttributeNameMap.forEach(
      (attributeName, attributeNameVariable) => {
        if (!ExpressionAttributeNames) {
          ExpressionAttributeNames = {};
        }
        ExpressionAttributeNames[attributeNameVariable] = attributeName;
      },
    );
    expressionAttributeValueMap!.forEach((value, attributeValueVariable) => {
      if (!ExpressionAttributeValues) {
        ExpressionAttributeValues = {};
      }
      ExpressionAttributeValues[attributeValueVariable] = value;
    });

    this.logger.debug('DynamoDB request started', { operation: 'update', tableKey });
    const updateCommand = new UpdateCommand({
      TableName: table.name,
      Key: keys,
      UpdateExpression,
      ...(ConditionExpression !== '' ? { ConditionExpression } : {}),
      ...(ExpressionAttributeNames !== null
        ? { ExpressionAttributeNames }
        : {}),
      ...(ExpressionAttributeValues !== null
        ? { ExpressionAttributeValues }
        : {}),
      ReturnConsumedCapacity:
        opts.returnConsumedCapacity ?? ReturnConsumedCapacity.NONE,
      ReturnValues: opts.returnValue ?? 'NONE',
    });

    const result: DynamoDBUpdateResult<T> = {
      updatedOrCreated: false,
    };
    try {
      const { Attributes: updatedItem } =
        await this.ddbDocClient.send(updateCommand);

      if (updatedItem !== undefined) {
        result.item = updatedItem as Partial<T>;
      }

      if (table.timeToLiveAttribute && expiresAt !== 0) {
        result.expiresAt = expiresAt;
        if (result.item) {
          delete (result.item as Record<string, any>)[table.timeToLiveAttribute]; // Delete the time to live attribute from the item
        }
      }

      result.updatedOrCreated = true;
    } catch (e: any) {
      const error = e as Error;
      if (error.name === 'ValidationException') {
        this.logger.error('The request parameters are invalid', { errorName: error.name, tableKey });
        throw new DynamoDBError(400, {
          message: 'Invalid request parameters',
          cause: e,
        });
      } else if (error.name === 'ConditionalCheckFailedException') {
        this.logger.debug('DynamoDB update skipped: condition not met', { tableKey });
      } else {
        this.logger.error('Failed to update item', { errorName: error.name, tableKey });
        throw new DynamoDBError(500, {
          message: 'Failed to update item',
          cause: e,
        });
      }
    }

    if (result.item) {
      // Convert keys back to camelCase if camelOrSnake is 'camel' or to snake_case if camelOrSnake is 'snake'
      if (camelOrSnake === 'camel') {
        const newItem: Record<string, any> = {};
        Object.keys(result.item).forEach(key => {
          const value = (result.item as Record<string, any>)[key];
          newItem[lcFirst(key)] = value;
        });
        result.item = newItem as T;
      } else {
        const newItem: Record<string, any> = {};
        Object.keys(result.item).forEach(key => {
          const value = (result.item as Record<string, any>)[key];
          newItem[snake(lcFirst(key))] = value;
        });
        result.item = newItem as T;
      }
    }

    this.logger.debug('DynamoDB update completed', { tableKey, updatedOrCreated: result.updatedOrCreated });
    return result;
  }

  async deleteOne<T>(
    tableKey: string,
    primaryKey:
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer],
    condition: DynamoDBExpression | null = null,
    opts: DynamoDBDeleteOptions = {},
    camelOrSnake: 'camel' | 'snake' = 'camel',
  ): Promise<DynamoDBDeleteOneResult<T>> {
    const table = this.options.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }

    const keys = Array.isArray(primaryKey)
      ? {
        [table.partitionKey]: primaryKey[0],
        [table.sortKey!]: primaryKey[1],
      }
      : {
        [table.partitionKey]: primaryKey,
      };

    let ConditionExpression: string = '';
    let ExpressionAttributeNames: Record<string, string> | null = null;
    let ExpressionAttributeValues: Record<string, any> | null = null;

    if (condition) {
      condition.expressionAttributeNameMap.forEach(
        (attributeName, attributeNameVariable) => {
          if (!ExpressionAttributeNames) {
            ExpressionAttributeNames = {};
          }
          ExpressionAttributeNames[attributeNameVariable] = attributeName;
        },
      );
      if (condition.expressionAttributeValueMap) {
        condition.expressionAttributeValueMap.forEach(
          (value, attributeValueVariable) => {
            if (!ExpressionAttributeValues) {
              ExpressionAttributeValues = {};
            }
            ExpressionAttributeValues[attributeValueVariable] = value;
          },
        );
      }
      ConditionExpression = condition.expression;
    }

    this.logger.debug('DynamoDB request started', { operation: 'deleteOne', tableKey });
    const deleteCommand = new DeleteCommand({
      TableName: table.name,
      Key: keys,
      ...(ConditionExpression !== '' ? { ConditionExpression } : {}),
      ...(ExpressionAttributeNames !== null
        ? { ExpressionAttributeNames }
        : {}),
      ...(ExpressionAttributeValues !== null
        ? { ExpressionAttributeValues }
        : {}),
      ReturnConsumedCapacity:
        opts.returnConsumedCapacity ?? ReturnConsumedCapacity.NONE,
      ReturnValues: opts.returnValue ?? 'NONE',
    });

    const result: DynamoDBDeleteOneResult<T> = {
      deleted: false,
    };

    try {
      const { Attributes: deletedItem } =
        await this.ddbDocClient.send(deleteCommand);
      result.deleted = true;

      if (deletedItem !== undefined) {
        result.deleted = true;
        result.item = deletedItem as T;
      }
    } catch (e: any) {
      const error = e as Error;
      if (error.name === 'ValidationException') {
        this.logger.error('The request parameters are invalid', { errorName: error.name, tableKey });
        throw new DynamoDBError(400, {
          message: 'Invalid request parameters',
          cause: e,
        });
      } else if (error.name === 'ConditionalCheckFailedException') {
        this.logger.debug('DynamoDB delete skipped: condition not met', { tableKey });
      } else {
        this.logger.error('Failed to delete item', { errorName: error.name, tableKey });
        throw new DynamoDBError(500, {
          message: 'Failed to delete item',
          cause: e,
        });
      }
    }

    if (result.item) {
      // Convert keys back to camelCase if camelOrSnake is 'camel' or to snake_case if camelOrSnake is 'snake'
      if (camelOrSnake === 'camel') {
        const newItem: Record<string, any> = {};
        Object.keys(result.item).forEach(key => {
          const value = (result.item as Record<string, any>)[key];
          newItem[lcFirst(key)] = value;
        });
        result.item = newItem as T;
      } else {
        const newItem: Record<string, any> = {};
        Object.keys(result.item).forEach(key => {
          const value = (result.item as Record<string, any>)[key];
          newItem[snake(lcFirst(key))] = value;
        });
        result.item = newItem as T;
      }
    }

    this.logger.debug('DynamoDB deleteOne completed', { tableKey, deleted: result.deleted });
    return result;
  }

  async deleteMany(
    tableKey: string,
    primaryKeys: (
      | string
      | number
      | Buffer
      | [string | number | Buffer, string | number | Buffer]
    )[],
    opts: Omit<DynamoDBDeleteOptions, 'returnValue'> = {},
  ): Promise<DynamoDBDeleteManyResult> {
    const table = this.options.tables.get(tableKey);
    if (!table) {
      throw new Error(`Table ${tableKey} not configured`);
    }

    const keys = primaryKeys.map(primaryKey => {
      const isArrayOfKeys = Array.isArray(primaryKey);

      return isArrayOfKeys
        ? {
          [table.partitionKey]: primaryKey[0],
          [table.sortKey!]: primaryKey[1],
        }
        : {
          [table.partitionKey]: primaryKey,
        };
    });

    const result: DynamoDBDeleteManyResult = {
      numberOfItems: primaryKeys.length,
    };

    let unprocessedAttempt = 0;
    while (keys.length > 0) {
      const batch = keys.splice(0, 25);

      this.logger.debug('DynamoDB batch request started', { operation: 'deleteMany', tableKey, itemCount: batch.length });
      const batchWriteCommand = new BatchWriteCommand({
        RequestItems: {
          [table.name]: batch.map(key => ({
            DeleteRequest: {
              Key: key,
            },
          })),
        },
        ReturnConsumedCapacity:
          opts.returnConsumedCapacity ?? ReturnConsumedCapacity.NONE,
      });

      const { UnprocessedItems } = await this.ddbDocClient
        .send(batchWriteCommand)
        .catch((e: Error) => {
          this.logger.error('Failed to delete items', { errorName: e.name, tableKey });
          throw new DynamoDBError(500, {
            message: 'Failed to delete items',
            cause: e,
          });
        });

      const unprocessedItems = UnprocessedItems?.[table.name];
      if (unprocessedItems !== undefined && unprocessedItems.length > 0) {
        if (unprocessedAttempt >= MAX_UNPROCESSED_ATTEMPTS) {
          this.logger.error('DynamoDB batch retry limit reached', { operation: 'deleteMany', tableKey, retryCount: unprocessedAttempt });
          throw new DynamoDBError(500, {
            message: 'Failed to delete items after multiple attempts',
            cause: new Error('Too many unprocessed items'),
          });
        }
        const delayMs = backoffDelayMs(unprocessedAttempt);
        this.logger.warn('DynamoDB retrying unprocessed batch items', { operation: 'deleteMany', tableKey, itemCount: unprocessedItems.length, attempt: unprocessedAttempt + 1, delayMs });
        await sleep(delayMs);
        unprocessedAttempt += 1;
        keys.push(
          ...(unprocessedItems
            .map(item => item.DeleteRequest?.Key)
            .filter(key => key !== undefined) as Record<string, any>[]),
        );
      } else {
        unprocessedAttempt = 0;
      }
    }

    this.logger.debug('DynamoDB deleteMany completed', { tableKey, itemCount: result.numberOfItems });
    return result;
  }

  transaction(opts: DynamoDBTransactionOptions) {
    const { mode, now, returnConsumedCapacity } = opts;
    return new DynamoDBTransaction(
      mode,
      this.ddbDocClient,
      this.options.tables,
      this.options.txRetryLimit ?? 3,
      this.options.txRetryDelay ?? 50,
      this.logger,
      now ?? getUnixTime(new Date()),
      returnConsumedCapacity ?? ReturnConsumedCapacity.NONE,
    );
  }
}

export { DynamoDBService };
