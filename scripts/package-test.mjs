import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const name = JSON.parse(readFileSync('package.json', 'utf8')).name;
const cjs = createRequire(import.meta.url)(name);
const esm = await import(name);
assert.equal(typeof cjs.DynamoDBService, 'function');
assert.equal(typeof esm.default, 'function');
assert.deepEqual([...cjs.Equal('user_name', 1).expressionAttributeNameMap.values()], ['UserName']);
assert.deepEqual(Object.keys(cjs).filter(k => k !== '__esModule').sort(), Object.keys(esm).sort());
// Test the actual archive's exports and declarations outside this repository.
const dir = mkdtempSync(join(tmpdir(), 'dynamodb-lib-package-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--cache', join(dir, 'cache'), '--ignore-scripts', '--json', '--pack-destination', dir], { encoding: 'utf8' }))[0];
  assert.ok(packed.files.every(f => !f.path.startsWith('tests/') && !f.path.includes('.env')));
  const packageDir = join(dir, 'node_modules', ...name.split('/'));
  mkdirSync(packageDir, { recursive: true });
  execFileSync('tar', ['-xzf', join(dir, packed.filename), '--strip-components=1', '-C', packageDir]);
  for (const dependency of ['@aws-sdk', '@smithy', 'radash', '@types']) symlinkSync(resolve('node_modules', dependency), join(dir, 'node_modules', dependency), 'dir');
  for (const [extension, source] of [['mts', `import Service, { DynamoDBConfig } from '${name}'; const config: DynamoDBConfig = { tables: new Map() }; new Service(config);`], ['cts', `import { DynamoDBService, DynamoDBConfig } from '${name}'; const config: DynamoDBConfig = { tables: new Map() }; new DynamoDBService(config);`]]) {
    writeFileSync(join(dir, `consumer.${extension}`), source);
  }
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', join(dir, 'consumer.mts'), join(dir, 'consumer.cts')], { stdio: 'inherit' });
  execFileSync(process.execPath, ['--input-type=module', '-e', `import {DynamoDBService} from '${name}'; if(typeof DynamoDBService !== 'function') process.exit(1)`], { cwd: dir, stdio: 'inherit' });
  execFileSync(process.execPath, ['-e', `if(typeof require('${name}').DynamoDBService !== 'function') process.exit(1)`], { cwd: dir, stdio: 'inherit' });
  console.log('ESM, CJS, packed exports and TypeScript consumer checks passed');
} finally { rmSync(dir, { recursive: true, force: true }); }
