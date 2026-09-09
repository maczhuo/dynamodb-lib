// A clean npm consumer must receive the audited, Node 18-compatible transitive versions.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const dir = mkdtempSync(join(tmpdir(), 'dynamodb-lib-install-'));
try {
  const archive = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { encoding: 'utf8' }))[0];
  writeFileSync(join(dir, 'package.json'), '{"name":"consumer","version":"1.0.0","private":true}');
  execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', join(dir, archive.filename)], { cwd: dir, stdio: 'inherit' });
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const parser = Object.entries(lock.packages).filter(([path]) => path.endsWith('/fast-xml-parser'));
  assert.ok(parser.length); assert.ok(parser.every(([, p]) => p.version === '5.7.1'));
  const window = Object.entries(lock.packages).filter(([path]) => path.endsWith('/util-locate-window'));
  assert.ok(window.every(([, p]) => p.version === '3.953.0'));
  for (const args of [['--input-type=module', '-e', "import {Equal} from '@jzhuo3/dynamodb-lib'; if (!Equal('x',1).expression) process.exit(1)"], ['-e', "if (!require('@jzhuo3/dynamodb-lib').Equal('x',1).expression) process.exit(1)"]]) {
    execFileSync(process.env.TEST_NODE || process.execPath, args, { cwd: dir, stdio: 'inherit' });
  }
  execFileSync('npm', ['audit', '--omit=dev'], { cwd: dir, stdio: 'inherit' });
  console.log('Fresh consumer install, dependency pins, ESM and CJS passed');
} finally { rmSync(dir, { recursive: true, force: true }); }
