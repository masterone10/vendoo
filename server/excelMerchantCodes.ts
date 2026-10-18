import { db } from './db.js';

export interface MerchantCodeImportRow {
  orderCode?: string | null;
  vendorId?: number | null;
  productName?: string | null;
  merchantCode: string;
  merchantName?: string | null;
  sourceSheetName?: string | null;
  excelRowIndex?: number | null;
}

export interface MerchantCodeImportReport {
  totalRows: number;
  validCodesProcessed: number;
  orderItemsEnriched: number;
  unmatchedRecords: number;
  conflictingMappings: number;
  unresolvedCount: number;
  verifiedHeader: string;
  warnings: string[];
}

// Recognized dedicated Excel headers for merchant code (never parsed from product title)
export const DEDICATED_MERCHANT_CODE_HEADERS = [
  'كود المخزن',
  'المخزن',
  'كود التاجر',
  'كود التاجر في الاكسيل',
  'كود المورد',
  'warehouse_code',
  'Warehouse Code',
  'merchant_code',
  'Merchant Code',
  'MerchantCode',
  'merchantCode',
  'vendor_code',
  'Vendor Code',
];

/**
 * Extracts the dedicated merchant code from an Excel row object.
 * Strictly preserves leading zeros and text format.
 * Never extracts an 8-digit sequence from product names!
 */
export function extractMerchantCodeFromRow(row: Record<string, any>): { code: string | null; matchedHeader: string | null } {
  for (const header of DEDICATED_MERCHANT_CODE_HEADERS) {
    if (header in row && row[header] !== undefined && row[header] !== null) {
      const rawVal = row[header];
      const strVal = typeof rawVal === 'string' ? rawVal.trim() : String(rawVal).trim();
      if (strVal.length > 0) {
        return { code: strVal, matchedHeader: header };
      }
    }
  }

  // Also check normalized lowercase keys
  for (const key of Object.keys(row)) {
    const normKey = key.trim().toLowerCase();
    if (normKey === 'merchant_code' || normKey === 'merchant code' || normKey === 'vendor_code' || normKey === 'كود التاجر') {
      const rawVal = row[key];
      const strVal = typeof rawVal === 'string' ? rawVal.trim() : String(rawVal).trim();
      if (strVal.length > 0) {
        return { code: strVal, matchedHeader: key };
      }
    }
  }

  return { code: null, matchedHeader: null };
}

/**
 * Applies merchant code mappings idempotently to database order_items.
 */
export function applyMerchantCodeMappings(rows: MerchantCodeImportRow[]): MerchantCodeImportReport {
  let validCodesProcessed = 0;
  let orderItemsEnriched = 0;
  let unmatchedRecords = 0;
  let conflictingMappings = 0;
  const warnings: string[] = [];

  const updateItemByOrderCode = db.prepare(`
    UPDATE order_items
    SET merchant_code = ?
    WHERE order_id IN (
      SELECT id FROM orders WHERE random_number = ? OR order_no = ?
    ) AND (merchant_code != ? OR merchant_code IS NULL)
  `);

  const updateItemByVendoorId = db.prepare(`
    UPDATE order_items
    SET merchant_code = ?
    WHERE order_id IN (
      SELECT id FROM orders WHERE vendoor_id = ?
    ) AND (merchant_code != ? OR merchant_code IS NULL)
  `);

  const insertMapping = db.prepare(`
    INSERT INTO merchant_code_mappings (
      merchant_code, merchant_name, source_sheet_name, excel_row_index, notes
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(merchant_code, source_sheet_name) DO UPDATE SET
      merchant_name = COALESCE(EXCLUDED.merchant_name, merchant_code_mappings.merchant_name),
      notes = EXCLUDED.notes
  `);

  db.exec('BEGIN TRANSACTION;');
  try {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rawCode = (r.merchantCode || '').trim();

      if (!rawCode) {
        warnings.push(`Row ${i + 1}: Missing merchant code`);
        continue;
      }

      // Check if someone accidentally passed an 8-digit product title extraction
      if (/^\d{8}$/.test(rawCode) && r.productName && r.productName.includes(rawCode) && !r.orderCode && !r.vendorId) {
        warnings.push(`Row ${i + 1}: Rejected potential extracted 8-digit sequence from product title: ${rawCode}`);
        conflictingMappings++;
        continue;
      }

      validCodesProcessed++;

      // Save mapping record
      insertMapping.run(rawCode, r.merchantName || null, r.sourceSheetName || 'Excel', r.excelRowIndex || i + 1, null);

      let updated = 0;
      if (r.orderCode) {
        const res = updateItemByOrderCode.run(rawCode, r.orderCode, r.orderCode, rawCode);
        updated += Number(res.changes);
      } else if (r.vendorId) {
        const res = updateItemByVendoorId.run(rawCode, r.vendorId, rawCode);
        updated += Number(res.changes);
      }

      if (updated > 0) {
        orderItemsEnriched += updated;
      } else if (r.orderCode || r.vendorId) {
        unmatchedRecords++;
      }
    }
    db.exec('COMMIT;');
  } catch (err: any) {
    db.exec('ROLLBACK;');
    throw err;
  }

  // Count items still with missing merchant codes
  const unresolved: any = db.prepare("SELECT COUNT(*) as c FROM order_items WHERE merchant_code IS NULL OR merchant_code = '' OR merchant_code = 'غير محدد'").get();

  return {
    totalRows: rows.length,
    validCodesProcessed,
    orderItemsEnriched,
    unmatchedRecords,
    conflictingMappings,
    unresolvedCount: unresolved?.c || 0,
    verifiedHeader: 'كود التاجر / merchant_code (Dedicated Column)',
    warnings: warnings.slice(0, 20),
  };
}
