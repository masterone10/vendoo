import React, { useState } from 'react';
import {
  X,
  FileText,
  User,
  Clock,
  Calendar,
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  ShoppingBag,
  Phone,
  MapPin,
  Tag,
  ArrowLeftRight,
  Code2,
} from 'lucide-react';
import { SystemLogEvent } from '../types';

interface LogDetailsModalProps {
  log: SystemLogEvent | null;
  onClose: () => void;
  onOpenOrder?: (orderCode: string) => void;
}

export const LogDetailsModal: React.FC<LogDetailsModalProps> = ({
  log,
  onClose,
  onOpenOrder,
}) => {
  const [copiedHash, setCopiedHash] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'raw'>('details');

  if (!log) return null;

  function handleCopyHash(hash?: string) {
    if (!hash) return;
    navigator.clipboard.writeText(hash);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  }

  // Format timestamps
  const eventTimeFormatted = log.event_timestamp
    ? new Date(log.event_timestamp).toLocaleString('ar-EG', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'غير متوفر';

  const importedTimeFormatted = log.imported_at
    ? new Date(log.imported_at).toLocaleString('ar-EG', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'غير متوفر';

  const getActionBadgeClass = (type: string) => {
    switch (type) {
      case 'status_change':
        return 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
      case 'note_added':
        return 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
      case 'address_edit':
        return 'bg-sky-500/10 text-sky-400 border border-sky-500/20';
      case 'phone_edit':
        return 'bg-violet-500/10 text-violet-400 border border-violet-500/20';
      case 'order_created':
        return 'bg-blue-500/10 text-blue-400 border border-blue-500/20';
      case 'customer_edit':
        return 'bg-teal-500/10 text-teal-400 border border-teal-500/20';
      case 'financial_edit':
        return 'bg-amber-600/10 text-amber-300 border border-amber-600/20';
      case 'print':
        return 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20';
      default:
        return 'bg-slate-800 text-slate-300 border border-slate-700';
    }
  };

  const getActionNameArabic = (type: string, fallback?: string) => {
    switch (type) {
      case 'status_change':
        return 'تغيير حالة الطلب';
      case 'note_added':
        return 'إضافة ملاحظة';
      case 'address_edit':
        return 'تعديل العنوان';
      case 'phone_edit':
        return 'تعديل الهاتف الإضافي / الأساسي';
      case 'order_created':
        return 'إنشاء طلب جديد';
      case 'customer_edit':
        return 'تعديل بيانات العميل';
      case 'financial_edit':
        return 'تعديل مالي / تكلفة الشحن';
      case 'product_edit':
        return 'تعديل منتج / مقاس / كمية';
      case 'print':
        return 'طباعة البوليصة';
      case 'general_edit':
        return 'تعديل في بيانات الطلب';
      case 'assign_staff':
        return 'تعيين موظف مسؤول';
      default:
        return fallback || 'إجراء تشغيلي';
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden font-['Cairo',sans-serif]" dir="rtl">
        {/* Header */}
        <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-100">
                  تفاصيل الحركة وسجل المراقبة #{log.id}
                </h3>
                <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${getActionBadgeClass(log.action_type)}`}>
                  {getActionNameArabic(log.action_type, log.action_label_ar)}
                </span>
                {log.order_match_status === 'MATCHED' ? (
                  <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1 font-mono">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>مرتبط بطلب</span>
                  </span>
                ) : log.order_match_status === 'GENERAL_LOG' ? (
                  <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                    حركة عامة
                  </span>
                ) : (
                  <span className="text-[11px] px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    <span>كود طلب غير مؤرشف محلياً</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-1 flex items-center gap-2">
                <span>توقيت الحدث: <strong className="text-slate-300 font-mono">{eventTimeFormatted}</strong></span>
                <span>·</span>
                <span>المنفذ: <strong className="text-amber-400">{log.actor_name || 'النظام'}</strong></span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab(activeTab === 'details' ? 'raw' : 'details')}
              className={`px-3 py-1.5 text-xs rounded-xl flex items-center gap-1.5 transition-colors cursor-pointer border ${
                activeTab === 'raw'
                  ? 'bg-amber-500 text-slate-950 border-amber-400 font-bold'
                  : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'
              }`}
              title="عرض السجل الخام الكامل"
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>{activeTab === 'raw' ? 'البيانات المعالجة' : 'البيانات الخام (JSON)'}</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-100 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-xs">
          {activeTab === 'raw' ? (
            /* Raw JSON View */
            <div className="space-y-4">
              <div className="flex items-center justify-between text-xs text-slate-400 border-b border-slate-800 pb-2">
                <span>الاستجابة الخام المخزنة في قاعدة البيانات (Immutable Raw Audit Record)</span>
                <button
                  onClick={() => handleCopyHash(JSON.stringify(log, null, 2))}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded flex items-center gap-1.5 cursor-pointer"
                >
                  {copiedHash ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>نسخ كود JSON</span>
                </button>
              </div>
              <pre className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-[11px] text-amber-300 font-mono overflow-x-auto whitespace-pre-wrap leading-relaxed dir-ltr">
                {JSON.stringify(log, null, 2)}
              </pre>
            </div>
          ) : (
            /* Structured Details View */
            <>
              {/* Section 1: Action Text & Values */}
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
                <h4 className="font-bold text-slate-200 flex items-center gap-2 border-b border-slate-800/80 pb-2">
                  <Tag className="w-4 h-4 text-amber-400" />
                  <span>تفاصيل الحركة والنص الأصلي من Vendoor</span>
                </h4>

                <div className="space-y-2">
                  <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-slate-200 text-xs font-medium leading-relaxed">
                    <span className="text-[11px] text-slate-400 block mb-1">النص المصدري الكامل دون اقتطاع:</span>
                    <span className="text-slate-100 font-semibold">{log.raw_action_text || 'غير متوفر'}</span>
                  </div>

                  {/* Value Diff if present */}
                  {(log.old_value || log.new_value || log.from_status || log.to_status) && (
                    <div className="p-3 rounded-lg bg-slate-900/80 border border-slate-800 space-y-2">
                      <span className="text-[11px] text-slate-400 font-semibold block">
                        مقارنة التغيير في {log.field_name || 'الحقل'}:
                      </span>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="p-2.5 rounded-lg bg-slate-950 border border-rose-500/20">
                          <span className="text-[10px] text-rose-400 block mb-1">القيمة السابقة (قبل التعديل):</span>
                          <span className="font-mono text-slate-300 font-medium">
                            {log.old_value || log.from_status || 'غير مسجلة في المصدر'}
                          </span>
                        </div>
                        <div className="p-2.5 rounded-lg bg-slate-950 border border-emerald-500/20">
                          <span className="text-[10px] text-emerald-400 block mb-1">القيمة الجديدة (بعد التعديل):</span>
                          <span className="font-mono text-emerald-300 font-bold">
                            {log.new_value || log.to_status || 'غير متوفر'}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Note block if note */}
                  {log.note_text && (
                    <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 space-y-1">
                      <span className="text-[11px] font-bold text-amber-400 block">نص الملاحظة المسجلة:</span>
                      <p className="text-slate-200 font-medium">{log.note_text}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Section 2: Audit & Execution Meta */}
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
                <h4 className="font-bold text-slate-200 flex items-center gap-2 border-b border-slate-800/80 pb-2">
                  <ShieldCheck className="w-4 h-4 text-sky-400" />
                  <span>بيانات التوثيق والتدقيق والمصدر</span>
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-slate-300">
                  <div className="flex justify-between p-2 rounded bg-slate-900/60">
                    <span className="text-slate-500">اسم الموظف / المنفذ:</span>
                    <span className="font-bold text-slate-100">{log.actor_name || 'النظام'}</span>
                  </div>

                  <div className="flex justify-between p-2 rounded bg-slate-900/60">
                    <span className="text-slate-500">طبيعة المنفذ:</span>
                    <span className="font-mono text-slate-300">
                      {log.is_system_actor ? 'حركة نظام تلقائية' : 'موظف تشغيل / خدمة عملاء'}
                    </span>
                  </div>

                  <div className="flex justify-between p-2 rounded bg-slate-900/60">
                    <span className="text-slate-500">توقيت الحدث (Cairo Time):</span>
                    <span className="font-mono text-slate-200">{eventTimeFormatted}</span>
                  </div>

                  <div className="flex justify-between p-2 rounded bg-slate-900/60">
                    <span className="text-slate-500">توقيت الجلب والاستيراد:</span>
                    <span className="font-mono text-slate-200">{importedTimeFormatted}</span>
                  </div>

                  <div className="flex justify-between p-2 rounded bg-slate-900/60">
                    <span className="text-slate-500">قناة المصدر في Vendoor:</span>
                    <span className="font-mono text-amber-400">{log.page_source || 'log/system'}</span>
                  </div>

                  <div className="flex justify-between p-2 rounded bg-slate-900/60">
                    <span className="text-slate-500">معرف طلب Vendoor:</span>
                    <span className="font-mono text-slate-200">
                      {log.vendoor_order_id ? `#${log.vendoor_order_id}` : 'غير متوفر'}
                    </span>
                  </div>
                </div>

                {log.source_hash && (
                  <div className="p-2.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span className="text-[11px] text-slate-500 shrink-0">بصمة التحقق (SHA256):</span>
                      <span className="font-mono text-[10px] text-slate-400 truncate dir-ltr">
                        {log.source_hash}
                      </span>
                    </div>
                    <button
                      onClick={() => handleCopyHash(log.source_hash)}
                      className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 cursor-pointer shrink-0"
                      title="نسخ البصمة"
                    >
                      {copiedHash ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )}
              </div>

              {/* Section 3: Linked Order Card (if matched) */}
              {log.order_code && (
                <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                    <h4 className="font-bold text-slate-200 flex items-center gap-2">
                      <ShoppingBag className="w-4 h-4 text-emerald-400" />
                      <span>بيانات الطلب المرتبط بالعملية</span>
                    </h4>

                    {onOpenOrder && (
                      <button
                        onClick={() => {
                          onClose();
                          onOpenOrder(log.order_code!);
                        }}
                        className="px-3 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <span>فتح تفاصيل الطلب الكاملة</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {log.order_match_status === 'MATCHED' ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-slate-300">
                      <div className="flex justify-between p-2 rounded bg-slate-900/60">
                        <span className="text-slate-500">كود الطلب / البوليصة:</span>
                        <span className="font-mono font-bold text-amber-400">{log.order_code}</span>
                      </div>

                      <div className="flex justify-between p-2 rounded bg-slate-900/60">
                        <span className="text-slate-500">رقم الطلب الداخلي:</span>
                        <span className="font-mono text-slate-200">{log.order_no || 'غير متوفر'}</span>
                      </div>

                      <div className="flex justify-between p-2 rounded bg-slate-900/60">
                        <span className="text-slate-500">حالة الطلب الحالية:</span>
                        <span className="font-bold text-slate-200 font-mono">{log.order_current_status || 'غير محدد'}</span>
                      </div>

                      <div className="flex justify-between p-2 rounded bg-slate-900/60">
                        <span className="text-slate-500">إجمالي الطلب:</span>
                        <span className="font-mono font-bold text-emerald-400">
                          {log.total_order !== undefined && log.total_order !== null ? `${log.total_order} ج.م` : 'غير متوفر'}
                        </span>
                      </div>

                      <div className="flex justify-between p-2 rounded bg-slate-900/60">
                        <span className="text-slate-500">اسم العميل:</span>
                        <span className="font-medium text-slate-100">{log.customer_name || 'غير متوفر'}</span>
                      </div>

                      <div className="flex justify-between p-2 rounded bg-slate-900/60">
                        <span className="text-slate-500">رقم الهاتف:</span>
                        <span className="font-mono text-slate-200">{log.customer_phone || 'غير متوفر'}</span>
                      </div>

                      <div className="flex justify-between p-2 rounded bg-slate-900/60">
                        <span className="text-slate-500">المحافظة:</span>
                        <span className="text-slate-200">{log.governorate || 'غير متوفر'}</span>
                      </div>

                      <div className="flex justify-between p-2 rounded bg-slate-900/60">
                        <span className="text-slate-500">عدد المخازن:</span>
                        <span className="font-mono text-slate-200">{log.distinct_merchant_count || 1}</span>
                      </div>

                      {log.order_address && (
                        <div className="col-span-1 md:col-span-2 p-2 rounded bg-slate-900/60 flex flex-col gap-1">
                          <span className="text-slate-500">العنوان المسجل:</span>
                          <span className="text-slate-200 font-medium">{log.order_address}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-800 text-slate-400 text-xs text-center space-y-1">
                      <p>
                        كود الطلب <strong className="text-amber-400 font-mono">{log.order_code}</strong> مذكور في حركة السجل، ولكنه غير موجود ضمن قائمة الطلبات النشطة حالياً في قاعدة البيانات.
                      </p>
                      <p className="text-[11px] text-slate-500">
                        قد يكون الطلب في حالة أرشيفية سابقة (مثل تم التسليم أو ملغي قديماً).
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between">
          <div className="text-[11px] text-slate-500 font-mono">
            معرف الحركة في النظام: {log.id}
          </div>
          <button
            onClick={onClose}
            className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl transition-colors cursor-pointer"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
