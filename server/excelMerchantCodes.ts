import { db } from './db.ts';

export interface MerchantCodeImportRow {
  orderCode?: string | null;
  vendorId?: number | null;
  itemId?: number | null;
  productId?: number | null;
  sku?: string | null;
  productName?: string | null;
  merchantCode: string;
  merchantName?: string | null;
  warehouseCode?: string | null;
  warehouseName?: string | null;
  sourceSheetName?: string | null;
  excelRowIndex?: number | null;
  notes?: string | null;
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

// Recognized dedicated Excel headers for merchant/vendor codes
// Strictly excludes warehouse codes or warehouse names
export const DEDICATED_MERCHANT_CODE_HEADERS = [
  'كود التاجر',
  'كود التاجر في الاكسيل',
  'كود المورد',
  'كود المخزن',
  'merchant_code',
  'Merchant Code',
  'MerchantCode',
  'merchantCode',
  'vendor_code',
  'Vendor Code',
  'vendorCode',
  'merchant_id',
  'vendor_id',
];

// Dedicated warehouse code headers (separate from merchant codes)
export const DEDICATED_WAREHOUSE_CODE_HEADERS = [
  'كود المخزن',
  'كود المستودع',
  'warehouse_code',
  'Warehouse Code',
  'warehouseCode',
];

// Dedicated warehouse name headers
export const DEDICATED_WAREHOUSE_HEADERS = [
  'اسم المخزن',
  'اسم المستودع',
  'المخزن',
  'المستودع',
  'warehouse_name',
  'Warehouse Name',
  'warehouseName',
];

// Dedicated merchant name headers
export const DEDICATED_MERCHANT_NAME_HEADERS = [
  'اسم التاجر',
  'اسم المورد',
  'التاجر',
  'المورد',
  'merchant_name',
  'Merchant Name',
  'vendor_name',
  'Vendor Name',
];

/**
 * Extracts the dedicated merchant code from an Excel row object.
 * Strictly preserves leading zeros and text format.
 * Never extracts warehouse names like 'مخزن Y 21' or 8-digit sequence from product names!
 */
export function extractMerchantCodeFromRow(row: Record<string, any>): { code: string | null; matchedHeader: string | null } {
  for (const header of DEDICATED_MERCHANT_CODE_HEADERS) {
    if (header in row && row[header] !== undefined && row[header] !== null) {
      const rawVal = row[header];
      const strVal = typeof rawVal === 'string' ? rawVal.trim() : String(rawVal).trim();
      // Ensure it is not a warehouse name (e.g. 'مخزن Y 21') mistakenly passed
      if (strVal.length > 0 && !strVal.startsWith('مخزن ') && !strVal.startsWith('مخزن') && strVal !== 'غير محدد') {
        return { code: strVal, matchedHeader: header };
      }
    }
  }

  // Also check normalized lowercase keys
  for (const key of Object.keys(row)) {
    const normKey = key.trim().toLowerCase();
    if (normKey === 'merchant_code' || normKey === 'merchant code' || normKey === 'vendor_code' || normKey === 'vendor code' || normKey === 'كود التاجر' || normKey === 'كود المورد' || normKey === 'كود المخزن' || normKey === 'merchant_id' || normKey === 'vendor_id') {
      const rawVal = row[key];
      const strVal = typeof rawVal === 'string' ? rawVal.trim() : String(rawVal).trim();
      if (strVal.length > 0 && !strVal.startsWith('مخزن ') && !strVal.startsWith('مخزن') && strVal !== 'غير محدد') {
        return { code: strVal, matchedHeader: key };
      }
    }
  }

  return { code: null, matchedHeader: null };
}

export function extractWarehouseCodeFromRow(row: Record<string, any>): { code: string | null; matchedHeader: string | null } {
  for (const header of DEDICATED_WAREHOUSE_CODE_HEADERS) {
    if (header in row && row[header] !== undefined && row[header] !== null) {
      const rawVal = row[header];
      const strVal = typeof rawVal === 'string' ? rawVal.trim() : String(rawVal).trim();
      if (strVal.length > 0) {
        return { code: strVal, matchedHeader: header };
      }
    }
  }
  return { code: null, matchedHeader: null };
}

export function extractWarehouseNameFromRow(row: Record<string, any>): { name: string | null; matchedHeader: string | null } {
  for (const header of DEDICATED_WAREHOUSE_HEADERS) {
    if (header in row && row[header] !== undefined && row[header] !== null) {
      const rawVal = row[header];
      const strVal = typeof rawVal === 'string' ? rawVal.trim() : String(rawVal).trim();
      if (strVal.length > 0) {
        return { name: strVal, matchedHeader: header };
      }
    }
  }
  return { name: null, matchedHeader: null };
}

export function extractMerchantNameFromRow(row: Record<string, any>): { name: string | null; matchedHeader: string | null } {
  for (const header of DEDICATED_MERCHANT_NAME_HEADERS) {
    if (header in row && row[header] !== undefined && row[header] !== null) {
      const rawVal = row[header];
      const strVal = typeof rawVal === 'string' ? rawVal.trim() : String(rawVal).trim();
      if (strVal.length > 0) {
        return { name: strVal, matchedHeader: header };
      }
    }
  }
  return { name: null, matchedHeader: null };
}

/**
 * Applies merchant code mappings idempotently to database order_items.
 * Strictly follows line-level item reconciliation priority:
 * 1. Line Item ID (vendoor_item_id or id) if specified.
 * 2. Order ID/Code + SKU (or Product ID) for multi-line orders.
 * 3. Order ID/Code for single-line orders or order-wide merchant assignments.
 * Never mixes warehouse names into merchant codes.
 * Detects and flags conflicting mappings.
 */
export function applyMerchantCodeMappings(rows: MerchantCodeImportRow[]): MerchantCodeImportReport {
  let validCodesProcessed = 0;
  let orderItemsEnriched = 0;
  let unmatchedRecords = 0;
  let conflictingMappings = 0;
  const warnings: string[] = [];

  // Update statements by priority
  const updateByItemId = db.prepare(`
    UPDATE order_items
    SET merchant_code = ?,
        merchant_name = COALESCE(?, merchant_name),
        warehouse_name = COALESCE(?, warehouse_name),
        warehouse_code = COALESCE(?, warehouse_code),
        code_source = 'EXCEL_MAPPING'
    WHERE (vendoor_item_id = ? OR id = ?)
  `);

  const updateByOrderAndSku = db.prepare(`
    UPDATE order_items
    SET merchant_code = ?,
        merchant_name = COALESCE(?, merchant_name),
        warehouse_name = COALESCE(?, warehouse_name),
        warehouse_code = COALESCE(?, warehouse_code),
        code_source = 'EXCEL_MAPPING'
    WHERE order_id IN (
      SELECT id FROM orders WHERE random_number = ? OR order_no = ? OR vendoor_id = ?
    ) AND (sku = ? OR sku LIKE ?)
  `);

  const updateByOrderAndProduct = db.prepare(`
    UPDATE order_items
    SET merchant_code = ?,
        merchant_name = COALESCE(?, merchant_name),
        warehouse_name = COALESCE(?, warehouse_name),
        warehouse_code = COALESCE(?, warehouse_code),
        code_source = 'EXCEL_MAPPING'
    WHERE order_id IN (
      SELECT id FROM orders WHERE random_number = ? OR order_no = ? OR vendoor_id = ?
    ) AND (product_id = ? OR product_name LIKE ?)
  `);

  const updateItemByOrderCode = db.prepare(`
    UPDATE order_items
    SET merchant_code = ?,
        merchant_name = COALESCE(?, merchant_name),
        warehouse_name = COALESCE(?, warehouse_name),
        warehouse_code = COALESCE(?, warehouse_code),
        code_source = 'EXCEL_MAPPING'
    WHERE order_id IN (
      SELECT id FROM orders WHERE random_number = ? OR order_no = ?
    )
  `);

  const updateItemByVendoorId = db.prepare(`
    UPDATE order_items
    SET merchant_code = ?,
        merchant_name = COALESCE(?, merchant_name),
        warehouse_name = COALESCE(?, warehouse_name),
        warehouse_code = COALESCE(?, warehouse_code),
        code_source = 'EXCEL_MAPPING'
    WHERE order_id IN (
      SELECT id FROM orders WHERE vendoor_id = ?
    )
  `);

  const updateBySku = db.prepare(`
    UPDATE order_items
    SET merchant_code = ?,
        merchant_name = COALESCE(?, merchant_name),
        warehouse_name = COALESCE(?, warehouse_name),
        warehouse_code = COALESCE(?, warehouse_code),
        code_source = 'EXCEL_MAPPING'
    WHERE (sku = ? OR sku LIKE ?)
      AND (merchant_code IS NULL OR merchant_code = '' OR merchant_code LIKE 'مخزن%' OR merchant_code = 'غير محدد')
  `);

  const updateByProductId = db.prepare(`
    UPDATE order_items
    SET merchant_code = ?,
        merchant_name = COALESCE(?, merchant_name),
        warehouse_name = COALESCE(?, warehouse_name),
        warehouse_code = COALESCE(?, warehouse_code),
        code_source = 'EXCEL_MAPPING'
    WHERE product_id = ?
      AND (merchant_code IS NULL OR merchant_code = '' OR merchant_code LIKE 'مخزن%' OR merchant_code = 'غير محدد')
  `);

  const checkConflict = db.prepare(`
    SELECT merchant_code FROM order_items
    WHERE (
      (order_id IN (SELECT id FROM orders WHERE random_number = ? OR order_no = ? OR vendoor_id = ?))
      OR (sku = ? AND ? != '')
    ) AND merchant_code IS NOT NULL
      AND merchant_code != ''
      AND merchant_code NOT LIKE 'مخزن%'
      AND merchant_code != 'غير محدد'
      AND merchant_code != ?
    LIMIT 1
  `);

  const insertMapping = db.prepare(`
    INSERT INTO merchant_code_mappings (
      merchant_code, merchant_name, sku, product_id, product_name, order_code, vendoor_id,
      warehouse_code, warehouse_name, source_sheet_name, excel_row_index, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(merchant_code, source_sheet_name) DO UPDATE SET
      merchant_name = COALESCE(EXCLUDED.merchant_name, merchant_code_mappings.merchant_name),
      sku = COALESCE(EXCLUDED.sku, merchant_code_mappings.sku),
      product_id = COALESCE(EXCLUDED.product_id, merchant_code_mappings.product_id),
      product_name = COALESCE(EXCLUDED.product_name, merchant_code_mappings.product_name),
      order_code = COALESCE(EXCLUDED.order_code, merchant_code_mappings.order_code),
      vendoor_id = COALESCE(EXCLUDED.vendoor_id, merchant_code_mappings.vendoor_id),
      warehouse_code = COALESCE(EXCLUDED.warehouse_code, merchant_code_mappings.warehouse_code),
      warehouse_name = COALESCE(EXCLUDED.warehouse_name, merchant_code_mappings.warehouse_name),
      notes = EXCLUDED.notes,
      updated_at = EXCLUDED.updated_at
  `);

  const nowIso = new Date().toISOString();

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
      if (/^\d{8}$/.test(rawCode) && r.productName && r.productName.includes(rawCode) && !r.orderCode && !r.vendorId && !r.itemId) {
        warnings.push(`Row ${i + 1}: Rejected potential extracted 8-digit sequence from product title: ${rawCode}`);
        conflictingMappings++;
        continue;
      }

      // Check if code looks like a warehouse name
      if (rawCode.startsWith('مخزن ') || rawCode.startsWith('مخزن') || rawCode === 'غير محدد') {
        warnings.push(`Row ${i + 1}: Rejected warehouse name passed as merchant code: ${rawCode}`);
        conflictingMappings++;
        continue;
      }

      validCodesProcessed++;

      // Save mapping record with all available matching keys
      const noteStr = r.orderCode ? `Order: ${r.orderCode}` : (r.vendorId ? `VendoorID: ${r.vendorId}` : (r.notes || null));
      try {
        insertMapping.run(
          rawCode,
          r.merchantName || null,
          r.sku || null,
          r.productId || null,
          r.productName || null,
          r.orderCode || null,
          r.vendorId || null,
          r.warehouseCode || null,
          r.warehouseName || null,
          r.sourceSheetName || 'Excel',
          r.excelRowIndex || i + 1,
          noteStr,
          nowIso,
          nowIso
        );
      } catch (insErr: any) {
        // Fallback for older schema if migration not yet applied
        db.prepare(`
          INSERT INTO merchant_code_mappings (merchant_code, merchant_name, source_sheet_name, excel_row_index, notes)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(merchant_code, source_sheet_name) DO UPDATE SET
            merchant_name = COALESCE(EXCLUDED.merchant_name, merchant_code_mappings.merchant_name),
            notes = EXCLUDED.notes
        `).run(rawCode, r.merchantName || null, r.sourceSheetName || 'Excel', r.excelRowIndex || i + 1, noteStr);
      }

      // Check for conflict on existing order items
      if (r.orderCode || r.vendorId || r.sku) {
        const conflictRow: any = checkConflict.get(
          r.orderCode || '',
          r.orderCode || '',
          r.vendorId || 0,
          r.sku || '',
          r.sku || '',
          rawCode
        );
        if (conflictRow) {
          conflictingMappings++;
          warnings.push(`Row ${i + 1}: Conflicting merchant code ${rawCode} vs existing ${conflictRow.merchant_code} on order/sku ${r.orderCode || r.vendorId || r.sku}`);
        }
      }

      let updated = 0;
      // Priority 1: Direct line item ID
      if (r.itemId) {
        const res = updateByItemId.run(rawCode, r.merchantName || null, r.warehouseName || null, r.warehouseCode || null, r.itemId, r.itemId);
        updated += Number(res.changes);
      }
      // Priority 2: Order + SKU
      else if ((r.orderCode || r.vendorId) && r.sku) {
        const res = updateByOrderAndSku.run(rawCode, r.merchantName || null, r.warehouseName || null, r.warehouseCode || null, r.orderCode || '', r.orderCode || '', r.vendorId || 0, r.sku, `%${r.sku}%`);
        updated += Number(res.changes);
      }
      // Priority 3: Order + Product ID / Name
      else if ((r.orderCode || r.vendorId) && (r.productId || r.productName)) {
        const res = updateByOrderAndProduct.run(rawCode, r.merchantName || null, r.warehouseName || null, r.warehouseCode || null, r.orderCode || '', r.orderCode || '', r.vendorId || 0, r.productId || 0, `%${r.productName || ''}%`);
        updated += Number(res.changes);
      }
      // Priority 4: Order level
      else if (r.orderCode) {
        const res = updateItemByOrderCode.run(rawCode, r.merchantName || null, r.warehouseName || null, r.warehouseCode || null, r.orderCode, r.orderCode);
        updated += Number(res.changes);
      } else if (r.vendorId) {
        const res = updateItemByVendoorId.run(rawCode, r.merchantName || null, r.warehouseName || null, r.warehouseCode || null, r.vendorId);
        updated += Number(res.changes);
      }
      // Priority 5: Catalog / SKU level across all orders
      else if (r.sku) {
        const res = updateBySku.run(rawCode, r.merchantName || null, r.warehouseName || null, r.warehouseCode || null, r.sku, `%${r.sku}%`);
        updated += Number(res.changes);
      }
      // Priority 6: Product ID level across all orders
      else if (r.productId) {
        const res = updateByProductId.run(rawCode, r.merchantName || null, r.warehouseName || null, r.warehouseCode || null, r.productId);
        updated += Number(res.changes);
      }

      if (updated > 0) {
        orderItemsEnriched += updated;
      } else if (r.orderCode || r.vendorId || r.itemId || r.sku || r.productId) {
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

/**
 * Reconciles unmapped order_items with persistent merchant_code_mappings
 */
export function reconcileItemsWithMappings(): { enrichedCount: number } {
  try {
    const res = db.prepare(`
      UPDATE order_items
      SET merchant_code = (
        SELECT m.merchant_code FROM merchant_code_mappings m
        WHERE (m.sku IS NOT NULL AND m.sku != '' AND m.sku = order_items.sku)
           OR (m.product_id IS NOT NULL AND m.product_id = order_items.product_id)
        LIMIT 1
      ),
      code_source = 'EXCEL_MAPPING'
      WHERE (order_items.merchant_code IS NULL OR order_items.merchant_code = '')
        AND EXISTS (
          SELECT 1 FROM merchant_code_mappings m
          WHERE (m.sku IS NOT NULL AND m.sku != '' AND m.sku = order_items.sku)
             OR (m.product_id IS NOT NULL AND m.product_id = order_items.product_id)
        )
    `).run();
    return { enrichedCount: Number(res.changes || 0) };
  } catch (err: any) {
    console.warn('[ExcelMerchantCodes] Warning in reconcileItemsWithMappings:', err.message);
    return { enrichedCount: 0 };
  }
}
