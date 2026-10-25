import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestRunResult {
  file: string;
  success: boolean;
  durationMs: number;
  output: string;
}

async function runSingleTest(filePath: string): Promise<TestRunResult> {
  const fileName = path.basename(filePath);
  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', filePath], {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ISOLATED_TEST_DB: 'true',
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      const combined = (stdout + '\n' + stderr).trim();
      resolve({
        file: fileName,
        success: code === 0,
        durationMs,
        output: combined,
      });
    });

    proc.on('error', (err) => {
      const durationMs = Date.now() - startTime;
      resolve({
        file: fileName,
        success: false,
        durationMs,
        output: err.message,
      });
    });
  });
}

async function main() {
  const testsDir = __dirname;
  const selfName = path.basename(__filename);

  // Discover all test files
  const discoveredFiles = fs
    .readdirSync(testsDir)
    .filter((f) => {
      if (f === selfName) return false;
      return (f.endsWith('.test.ts') || f.endsWith('.ts')) && !f.endsWith('.d.ts');
    })
    .sort();

  console.log('='.repeat(80));
  console.log(` VENDOOR COMPREHENSIVE TEST SUITE RUNNER`);
  console.log(` Discovered Test Files: ${discoveredFiles.length} files in server/tests/`);
  console.log('='.repeat(80));

  discoveredFiles.forEach((f, idx) => {
    console.log(`  [${String(idx + 1).padStart(2, '0')}/${discoveredFiles.length}] ${f}`);
  });
  console.log('='.repeat(80));

  const results: TestRunResult[] = [];
  let passedCount = 0;
  let failedCount = 0;
  const overallStartTime = Date.now();

  for (let i = 0; i < discoveredFiles.length; i++) {
    const file = discoveredFiles[i];
    const fullPath = path.join(testsDir, file);
    const progress = `[${String(i + 1).padStart(2, '0')}/${discoveredFiles.length}]`;

    process.stdout.write(` Running ${progress} ${file.padEnd(52, ' ')} ... `);
    const res = await runSingleTest(fullPath);
    results.push(res);

    if (res.success) {
      passedCount++;
      console.log(`✅ PASSED (${(res.durationMs / 1000).toFixed(2)}s)`);
    } else {
      failedCount++;
      console.log(`❌ FAILED (${(res.durationMs / 1000).toFixed(2)}s)`);
      console.error('\n--- FAILURE LOG: ' + file + ' ---');
      console.error(res.output.slice(0, 2000));
      console.error('--- END FAILURE LOG ---\n');
    }
  }

  const overallDurationSec = ((Date.now() - overallStartTime) / 1000).toFixed(2);

  console.log('\n' + '='.repeat(80));
  console.log(` TEST RUN EXECUTION SUMMARY`);
  console.log('='.repeat(80));
  console.log(` Total Discovered Test Files: ${discoveredFiles.length}`);
  console.log(` Total Executed Test Files:   ${results.length}`);
  console.log(` Total Passed:                ${passedCount}`);
  console.log(` Total Failed:                ${failedCount}`);
  console.log(` Total Suite Duration:        ${overallDurationSec}s`);
  console.log('='.repeat(80));

  if (failedCount > 0) {
    console.error(`\n❌ TEST SUITE FAILED: ${failedCount} of ${discoveredFiles.length} test files failed.\n`);
    process.exit(1);
  } else {
    console.log(`\n🎉 ALL ${discoveredFiles.length} TEST FILES DISCOVERED AND EXECUTED SUCCESSFULLY! 🎉\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
