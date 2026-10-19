import React, { useState } from 'react';
import { X, Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, HelpCircle, ArrowRight } from 'lucide-react';
import { MerchantCodeImportReport } from '../types';

interface MerchantCodeImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportSuccess: () => void;
}

export const MerchantCodeImportModal: React.FC<MerchantCodeImportModalProps> = ({
  isOpen,
  onClose,
  onImportSuccess,
}) => {
  const [pastedText, setPastedText] = useState('');
  const [sourceSheetName, setSourceSheetName] = useState('ملف التجار المعتمد');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<MerchantCodeImportReport | null>(null);

  if (!isOpen) return null;

  function parseCsvOrTsv(text: string): Record<string, string>[] {
    const lines = text.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) return [];

    // Detect delimiter: tab or comma
    const delimiter = lines[0].includes('\t') ? '\t' : ',';
    const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^["']|["']$/g, ''));

    const rows: Record<string, string>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(delimiter).map(p => p.trim().replace(/^["']|["']$/g, ''));
      const obj: Record<string, string> = {};
      headers.forEach((h, idx) => {
        if (h) {
          obj[h] = parts[idx] !== undefined ? parts[idx] : '';
        }
      });
      rows.push(obj);
    }
    return rows;
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      setPastedText(text);
      setSourceSheetName(file.name.replace(/\.[^/.]+$/, ''));
      setError(null);
    } catch (err: any) {
      setError(`فشل قراءة الملف: ${err.message}`);
    }
  }

  async function handleProcessImport() {
    if (!pastedText.trim()) {
      setError('يرجى لصق بيانات الجدول أو اختيار ملف CSV/Excel');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      setReport(null);

      const parsedRows = parseCsvOrTsv(pastedText);
      if (parsedRows.length === 0) {
        throw new Error('لم يتم العثور على أسطر صالحة. تأكد أن السطر الأول يحتوي ترويسات الأعمدة (مثل: كود التاجر، رقم الطلب، SKU).');
      }

      // Convert rows into canonical format
      const formattedRows = parsedRows.map((r, idx) => {
        // Find merchant code (strictly merchant/vendor codes, never warehouse)
        const merchantCode =
          r['كود التاجر'] ||
          r['كود التاجر في الاكسيل'] ||
          r['كود المورد'] ||
          r['merchant_code'] ||
          r['Merchant Code'] ||
          r['MerchantCode'] ||
          r['merchantCode'] ||
          r['vendor_code'] ||
          r['Vendor Code'] ||
          r['vendorCode'] ||
          r['merchant_id'] ||
          r['vendor_id'] ||
          '';

        const orderCode =
          r['رقم الطلب'] ||
          r['كود الطلب'] ||
          r['order_code'] ||
          r['Order Code'] ||
          r['random_number'] ||
          r['order_no'] ||
          r['البوليصة'] ||
          null;

        const vendorId = r['vendoor_id'] || r['معرف الطلب'] || r['Order ID'] ? parseInt(r['vendoor_id'] || r['معرف الطلب'] || r['Order ID'], 10) : null;
        const itemId = r['item_id'] || r['معرف الصنف'] || r['vendoor_item_id'] ? parseInt(r['item_id'] || r['معرف الصنف'] || r['vendoor_item_id'], 10) : null;
        const sku = r['SKU'] || r['كود الصنف'] || r['sku'] || r['كود المتغير'] || null;
        const productName = r['اسم الصنف'] || r['اسم المنتج'] || r['product_name'] || null;
        const merchantName = r['اسم التاجر'] || r['اسم المورد'] || r['merchant_name'] || r['التاجر'] || r['المورد'] || null;
        const warehouseName = r['اسم المستودع'] || r['اسم المخزن'] || r['المخزن'] || r['المستودع'] || r['warehouse_name'] || null;
        const warehouseCode = r['كود المستودع'] || r['كود المخزن'] || r['warehouse_code'] || r['Warehouse Code'] || null;

        return {
          merchantCode: String(merchantCode).trim(),
          orderCode: orderCode ? String(orderCode).trim() : null,
          vendorId: !isNaN(vendorId as any) ? vendorId : null,
          itemId: !isNaN(itemId as any) ? itemId : null,
          sku: sku ? String(sku).trim() : null,
          productName: productName ? String(productName).trim() : null,
          merchantName: merchantName ? String(merchantName).trim() : null,
          warehouseName: warehouseName ? String(warehouseName).trim() : null,
          warehouseCode: warehouseCode ? String(warehouseCode).trim() : null,
          sourceSheetName,
          excelRowIndex: idx + 2,
        };
      });

      const res = await fetch('/api/merchants/excel-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: formattedRows }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'حدث خطأ أثناء معالجة الاستيراد');
      }

      setReport(data.report);
      onImportSuccess();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200" dir="rtl">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-100 text-base">استيراد وتوفيق أكواد التجار (Excel / CSV)</h3>
              <p className="text-xs text-slate-400">ربط كود التاجر الحقيقي بسطور الأصناف والطلبات دون المساس بأسماء المخازن أو الحالات</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-5 text-sm">
          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 flex items-start gap-3 text-xs leading-relaxed">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Guidelines Box */}
          <div className="p-4 rounded-xl bg-slate-950/50 border border-slate-800 text-xs text-slate-300 space-y-2">
            <div className="flex items-center gap-2 font-bold text-slate-200">
              <HelpCircle className="w-4 h-4 text-sky-400" />
              <span>ضوابط استيراد أكواد التجار:</span>
            </div>
            <ul className="list-disc list-inside space-y-1 text-slate-400 pr-1">
              <li>يتم حفظ كود التاجر كنص نقي مع الحفاظ الصارم على الأصفار البادئة (مثال: <code className="text-amber-300 font-mono">00123456</code>).</li>
              <li>الربط يتم عبر معرف الطلب أو كود الطلب مع SKU للصنف لضمان دقة السطر.</li>
              <li>أسماء المخازن (مثل «مخزن Y 21») مستقلة تمامًا ولا يتم خلطها بكود التاجر.</li>
              <li>الترويسيات المعتمدة لكود التاجر: <code className="text-slate-300">كود التاجر</code>، <code className="text-slate-300">كود المورد</code>، <code className="text-slate-300">merchant_code</code>.</li>
            </ul>
          </div>

          {/* Import Inputs */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-200">
                اسم الملف / المصدر:
              </label>
              <span className="text-[11px] text-slate-500">للتوثيق في سجلات التدقيق</span>
            </div>
            <input
              type="text"
              value={sourceSheetName}
              onChange={(e) => setSourceSheetName(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 text-xs focus:outline-none focus:border-amber-500/50"
              placeholder="مثال: شيت تجار أكتوبر 2026"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-200">
                بيانات الجدول (لصق مباشر أو رفع ملف CSV):
              </label>
              <label className="cursor-pointer inline-flex items-center gap-1.5 text-xs text-amber-400 hover:text-amber-300 font-medium">
                <Upload className="w-3.5 h-3.5" />
                <span>رفع ملف CSV</span>
                <input
                  type="file"
                  accept=".csv,.tsv,.txt"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>
            <textarea
              rows={6}
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              placeholder={`انسخ الصفوف من Excel والصقها هنا، بحيث يتضمن السطر الأول العناوين، مثال:\nكود التاجر\tرقم الطلب\tكود الصنف (SKU)\tاسم التاجر\n00123456\ted6309\tPAN4-#FF0000-M\tتاجر الملابس`}
              className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-200 font-mono text-xs focus:outline-none focus:border-amber-500/50 resize-y leading-relaxed"
            />
          </div>

          {/* Success Report */}
          {report && (
            <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs space-y-2.5 animate-in fade-in">
              <div className="flex items-center gap-2 font-bold text-emerald-400">
                <CheckCircle2 className="w-4 h-4" />
                <span>تقرير اكتمال توفيق أكواد التجار بنجاح:</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-slate-200 pt-1">
                <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
                  <div className="text-[10px] text-slate-400 font-sans">إجمالي الأسطر:</div>
                  <div className="font-bold text-slate-100 text-sm">{report.totalRows}</div>
                </div>
                <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
                  <div className="text-[10px] text-emerald-400 font-sans">أصناف تم ربطها:</div>
                  <div className="font-bold text-emerald-400 text-sm">{report.orderItemsEnriched}</div>
                </div>
                <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
                  <div className="text-[10px] text-amber-400 font-sans">أكواد صالحة:</div>
                  <div className="font-bold text-amber-400 text-sm">{report.validCodesProcessed}</div>
                </div>
                <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
                  <div className="text-[10px] text-slate-400 font-sans">أسطر لم تطابق:</div>
                  <div className="font-bold text-slate-300 text-sm">{report.unmatchedRecords}</div>
                </div>
                <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
                  <div className="text-[10px] text-rose-400 font-sans">تعارضات مستبعدة:</div>
                  <div className="font-bold text-rose-400 text-sm">{report.conflictingMappings}</div>
                </div>
                <div className="p-2 rounded bg-slate-900/80 border border-slate-800">
                  <div className="text-[10px] text-slate-400 font-sans">أصناف بانتظار كود:</div>
                  <div className="font-bold text-slate-400 text-sm">{report.unresolvedCount}</div>
                </div>
              </div>

              {report.warnings && report.warnings.length > 0 && (
                <div className="mt-2 text-[11px] text-amber-300/90 bg-amber-500/10 p-2 rounded-lg border border-amber-500/20">
                  <span className="font-bold">ملاحظات التدقيق:</span> {report.warnings.slice(0, 3).join(' | ')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors"
          >
            إغلاق
          </button>
          <button
            onClick={handleProcessImport}
            disabled={isSubmitting || !pastedText.trim()}
            className="px-5 py-2 text-xs font-bold rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isSubmitting ? (
              <span>جاري المعالجة والمطابقة...</span>
            ) : (
              <>
                <span>تطبيق التوفيق والربط</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
