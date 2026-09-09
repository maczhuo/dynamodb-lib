import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
const tsc = ['node_modules/typescript/bin/tsc'];
execFileSync(process.execPath, tsc, { stdio: 'inherit' });
execFileSync(process.execPath, [...tsc, '--module', 'CommonJS', '--moduleResolution', 'Node', '--outDir', 'dist/cjs'], { stdio: 'inherit' });
writeFileSync('dist/cjs/package.json', '{"type":"commonjs"}\n');
