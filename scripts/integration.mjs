import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, region: { type: 'string' }, profile: { type: 'string' },
  'log-level': { type: 'string' }, aws: { type: 'boolean' }, 'table-prefix': { type: 'string' },
}});
const env = { ...process.env };
for (const [arg, name] of Object.entries({ 'log-level': 'DYNAMODB_TEST_LOG_LEVEL', endpoint: 'DYNAMODB_ENDPOINT', region: 'AWS_REGION', profile: 'AWS_PROFILE', 'table-prefix': 'DYNAMODB_TABLE_PREFIX' })) {
  if (values[arg] !== undefined) env[name] = values[arg];
}
if (values.aws) { env.DYNAMODB_TEST_AWS = '1'; delete env.DYNAMODB_ENDPOINT; }
execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
execFileSync(process.execPath, ['--test', 'tests/integration.test.mjs'], { stdio: 'inherit', env });
