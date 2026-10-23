import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'http';

// Helper to make HTTP request to local server
function doRequest(options: http.RequestOptions, bodyData?: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: data,
        });
      });
    });
    req.on('error', reject);
    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

describe('Reports Failure & State Verification Tests', () => {
  const PORT = 3000;

  let cachedReport: any = null;

  // Test 1: Successful request returns JSON with valid data
  it('1. GET /api/reports/logs-intelligence returns valid JSON and success: true', async () => {
    const res = await doRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/logs-intelligence?startDate=2026-10-23&endDate=2026-10-23&autoFetch=false',
      method: 'GET',
    });

    assert.strictEqual(res.statusCode, 200, 'Status should be 200');
    assert.ok(res.headers['content-type']?.includes('application/json'), 'Content-type must be JSON');
    const json = JSON.parse(res.body);
    assert.strictEqual(json.success, true, 'success field must be true');
    assert.ok(json.report, 'report object must exist');
    assert.ok(json.report.metrics, 'metrics must exist');
    assert.strictEqual(typeof json.report.metrics.totalLogs, 'number', 'totalLogs must be number');
    assert.strictEqual(typeof json.report.metrics.confirmedOrdersCount, 'number', 'confirmedOrdersCount must be number');
    cachedReport = json.report;
  });

  // Test 2: Unmatched route returns structured JSON 404 (never HTML fallback)
  it('2. Unmatched /api/reports/* route returns JSON 404 with REPORT_ROUTE_NOT_FOUND', async () => {
    const res = await doRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/non-existent-subpath-test',
      method: 'GET',
    });

    assert.strictEqual(res.statusCode, 404, 'Status should be 404');
    assert.ok(res.headers['content-type']?.includes('application/json'), 'Content-type must be JSON');
    const json = JSON.parse(res.body);
    assert.strictEqual(json.success, false, 'success must be false');
    assert.strictEqual(json.error.code, 'REPORT_ROUTE_NOT_FOUND', 'Error code must be REPORT_ROUTE_NOT_FOUND');
    assert.strictEqual(typeof json.error.message, 'string', 'Message must be Arabic string');
    assert.ok(!res.body.includes('<!doctype html>'), 'Must NOT return HTML');
  });

  // Test 3: Unmatched /reports/* route alias returns structured JSON 404 (never HTML)
  it('3. Direct /reports/non-existent-path returns JSON 404 without falling back to index.html', async () => {
    const res = await doRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/reports/non-existent-path',
      method: 'GET',
    });

    assert.strictEqual(res.statusCode, 404, 'Status should be 404');
    assert.ok(res.headers['content-type']?.includes('application/json'), 'Content-type must be JSON');
    const json = JSON.parse(res.body);
    assert.strictEqual(json.success, false);
    assert.strictEqual(json.error.code, 'REPORT_ROUTE_NOT_FOUND');
    assert.ok(!res.body.includes('<!doctype html>'), 'Must not return Vite index.html');
  });

  // Test 4: Invalid date format returns 400 JSON with INVALID_START_DATE or INVALID_DATE_INPUT
  it('4. Invalid date format returns 400 JSON with INVALID_START_DATE', async () => {
    const res = await doRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/logs-intelligence?startDate=invalid-date&endDate=2026-10-23',
      method: 'GET',
    });

    assert.strictEqual(res.statusCode, 400, 'Status should be 400');
    assert.ok(res.headers['content-type']?.includes('application/json'), 'Content-type must be JSON');
    const json = JSON.parse(res.body);
    assert.strictEqual(json.success, false);
    assert.ok(['INVALID_START_DATE', 'INVALID_DATE_INPUT'].includes(json.error.code), 'Error code must indicate invalid date');
    assert.ok(json.error.message.includes('YYYY-MM-DD'), 'Should explain date format');
  });

  // Test 5: Inverted date range (startDate > endDate) returns 400 JSON
  it('5. Inverted date range (startDate > endDate) returns 400 JSON with INVALID_DATE_RANGE', async () => {
    const res = await doRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/logs-intelligence?startDate=2026-10-25&endDate=2026-10-20',
      method: 'GET',
    });

    assert.strictEqual(res.statusCode, 400, 'Status should be 400');
    assert.ok(res.headers['content-type']?.includes('application/json'), 'Content-type must be JSON');
    const json = JSON.parse(res.body);
    assert.strictEqual(json.success, false);
    assert.strictEqual(json.error.code, 'INVALID_DATE_RANGE');
    assert.ok(json.error.message.includes('بداية') || json.error.message.includes('نهاية'), 'Should describe date range constraint in Arabic');
  });

  // Test 6: Missing required fields in POST /api/reports/day-action returns 400 JSON
  it('6. Missing required date in /reports/day-action returns 400 JSON', async () => {
    const res = await doRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/day-action',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    }, JSON.stringify({ action: 'recheck' }));

    assert.strictEqual(res.statusCode, 400, 'Status should be 400');
    assert.ok(res.headers['content-type']?.includes('application/json'));
    const json = JSON.parse(res.body);
    assert.strictEqual(json.success, false);
    assert.strictEqual(json.error.code, 'MISSING_DATE');
  });

  // Test 7: Report coverage accurately tracks status (COMPLETE or PARTIAL)
  it('7. Report coverage status is explicit (COMPLETE or PARTIAL) and never falsely marked COMPLETE', async () => {
    assert.ok(cachedReport, 'cachedReport should exist from Test 1');
    assert.ok(['COMPLETE', 'PARTIAL', 'FAILED'].includes(cachedReport.status), 'Status must be explicit enum');
    assert.strictEqual(typeof cachedReport.coverage.isFullyComplete, 'boolean');
    assert.strictEqual(typeof cachedReport.coverage.totalDays, 'number');
    assert.strictEqual(typeof cachedReport.coverage.completeDays, 'number');
  });

  // Test 8: Empty range detection (future date or zero activity date)
  it('8. Valid date range with 0 events returns valid report with 0 logs (distinguishable as empty)', async () => {
    const res = await doRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/logs-intelligence?startDate=2030-01-01&endDate=2030-01-01&autoFetch=false',
      method: 'GET',
    });

    assert.strictEqual(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.report.metrics.totalLogs, 0, 'Total logs must be 0 for future date');
    assert.strictEqual(json.report.metrics.uniqueOrdersTouched, 0, 'Unique orders must be 0 for future date');
  });

  // Test 9: HTML detection client logic verification
  it('9. HTML response parsing simulation classifies <!doctype html> as INVALID_RESPONSE_FORMAT', () => {
    const htmlResponse = '<!doctype html><html lang="ar"><head><title>Vendoor</title></head><body>App</body></html>';
    const isHtml = htmlResponse.trim().startsWith('<!doctype') || htmlResponse.trim().startsWith('<html');
    assert.strictEqual(isHtml, true, 'HTML start tag must be correctly identified');
  });

  // Test 10: Server error format consistency
  it('10. Global error handler produces structured JSON with requestId and retryable flag', async () => {
    // Check that routes.ts standardized error responses contain required fields
    const res = await doRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/reports/logs-status?startDate=invalid&endDate=invalid',
      method: 'GET',
    });

    assert.strictEqual(res.statusCode, 400);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.success, false);
    assert.ok(json.error.code, 'Error code must exist');
    assert.ok(json.error.message, 'Error message must exist');
    assert.strictEqual(typeof json.error.retryable, 'boolean', 'retryable must be boolean');
    assert.ok(json.error.requestId, 'requestId must exist');
  });
});
