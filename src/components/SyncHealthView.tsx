import React, { useState, useEffect } from 'react';
import { Activity, RefreshCw, CheckCircle2, AlertTriangle, XCircle, Clock, Database, ShieldCheck } from 'lucide-react';
import { SyncStatus } from '../types';

interface SyncHealthViewProps {
  syncStatus: SyncStatus | null;
  onManualSync: () => void;
  isSyncingManual: boolean;
}

export const SyncHealthView: React.FC<SyncHealthViewProps> = ({
  syncStatus,
  onManualSync,
  isSyncingManual,
}) => {
  const [runs, setRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchSyncRuns();
  }, [syncStatus?.lastSyncCompletedAt]);

  async function fetchSyncRuns() {
    setLoading(true);
    try {
      const res = await fetch('/api/sync/runs');
      const data = await res.json();
      setRuns(data.runs || []);
    } catch (err) {
      console.error('Error fetching sync runs:', err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Activity className="w-5 h-5 text-emerald-400" />
            <span>صحة المزامنة والتدقيق الرقابي (Sync Health & Audit)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            سجل التدقيق الشامل لدورات القراءة، فحص مطابقة البيانات الأصلية، وسجل الأخطاء التشغيلية
          </p>
        </div>

        <button
          onClick={onManualSync}
          disabled={isSyncingManual}
          className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-xs rounded-lg flex items-center gap-2 transition-colors cursor-pointer shadow-sm"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSyncingManual ? 'animate-spin' : ''}`} />
          <span>{isSyncingManual ? 'جاري التحقق الكامل...' : 'تشغيل مطابقة فورية'}</span>
        </button>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        {/* Status */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>حالة الخدمة</span>
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-lg font-bold text-emerald-400 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            <span>نشطة ومستمرة</span>
          </div>
          <div className="text-[11px] text-slate-500 font-mono">
            المرحلة: {syncStatus?.currentPhase || 'جاهز'}
          </div>
        </div>

        {/* Total Ingested Orders */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>الطلبات المحفوظة بقاعدة البيانات</span>
            <Database className="w-4 h-4 text-sky-400" />
          </div>
          <div className="text-2xl font-bold font-mono text-slate-100">
            {syncStatus?.totalOrdersInDb || 0}
          </div>
          <div className="text-[11px] text-slate-500">
            سجلات فريدة مع كامل الأصناف والأسعار
          </div>
        </div>

        {/* Last Successful Sync */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>آخر مطابقة ناجحة</span>
            <Clock className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-sm font-bold font-mono text-slate-200">
            {syncStatus?.lastSuccessfulSyncAt
              ? new Date(syncStatus.lastSuccessfulSyncAt).toLocaleTimeString('ar-EG', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })
              : 'لم تتم بعد'}
          </div>
          <div className="text-[11px] text-slate-500">
            فترة التكرار: كل 25 ثانية
          </div>
        </div>

        {/* Consecutive Errors */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>أخطاء الاتصال المتتالية</span>
            <AlertTriangle className="w-4 h-4 text-rose-400" />
          </div>
          <div className={`text-2xl font-bold font-mono ${syncStatus?.consecutiveFailures ? 'text-rose-400' : 'text-slate-100'}`}>
            {syncStatus?.consecutiveFailures || 0}
          </div>
          <div className="text-[11px] text-slate-500">
            {syncStatus?.lastError ? (
              <span className="text-rose-400 truncate block">{syncStatus.lastError}</span>
            ) : (
              'لا توجد انقطاعات شبكة'
            )}
          </div>
        </div>
      </div>

      {/* Sync Runs History */}
      <section className="space-y-3">
        <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <Clock className="w-4 h-4 text-slate-400" />
          <span>سجل دورات المزامنة والتدقيق الأخيرة</span>
        </h3>

        <div className="border border-slate-800 rounded-xl bg-slate-900/60 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/40 text-slate-400">
                  <th className="py-3 px-4 font-semibold">رقم الدورة</th>
                  <th className="py-3 px-4 font-semibold">نوع الدورة</th>
                  <th className="py-3 px-4 font-semibold">الحالة</th>
                  <th className="py-3 px-4 font-semibold">الطلبات الفريدة (خام)</th>
                  <th className="py-3 px-4 font-semibold">طلبات جديدة</th>
                  <th className="py-3 px-4 font-semibold">تغييرات بيانات فعلية</th>
                  <th className="py-3 px-4 font-semibold">تغير حالات المصدر</th>
                  <th className="py-3 px-4 font-semibold">تكرار عبر الصفحات</th>
                  <th className="py-3 px-4 font-semibold">المدة</th>
                  <th className="py-3 px-4 font-semibold">وقت البدء</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {loading ? (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-slate-500">
                      جاري تحميل السجلات...
                    </td>
                  </tr>
                ) : runs.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-slate-500">
                      لا توجد دورات مسجلة بعد
                    </td>
                  </tr>
                ) : (
                  runs.map((run) => (
                    <tr key={run.id} className="hover:bg-slate-800/30">
                      <td className="py-3 px-4 text-slate-400">#{run.id}</td>
                      <td className="py-3 px-4 font-sans font-medium text-slate-300">
                        {run.run_type === 'INITIAL' && 'استيراد أولي كامل'}
                        {run.run_type === 'PERIODIC' && 'دورية تدريجية'}
                        {run.run_type === 'MANUAL' && 'يدوية فورية'}
                        {run.run_type === 'RECONCILIATION' && 'مطابقة شاملة'}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`font-sans text-[11px] font-semibold px-2 py-0.5 rounded ${
                            run.status === 'SUCCESS'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : run.status === 'PARTIAL'
                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                              : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                          }`}
                        >
                          {run.status === 'SUCCESS' ? 'ناجحة' : run.status === 'PARTIAL' ? 'جزئية' : 'فشلت'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-200">
                        <span>{run.unique_source_ids || run.orders_scanned}</span>
                        {run.raw_rows_received && run.raw_rows_received !== (run.unique_source_ids || run.orders_scanned) ? (
                          <span className="text-[10px] text-slate-500 block">({run.raw_rows_received} صف خام)</span>
                        ) : null}
                      </td>
                      <td className="py-3 px-4 text-emerald-400">+{run.new_orders_inserted ?? run.orders_created}</td>
                      <td className="py-3 px-4 text-sky-400">{run.records_with_field_changes ?? 0}</td>
                      <td className="py-3 px-4 text-amber-400">{run.status_changes_count ?? run.events_detected}</td>
                      <td className="py-3 px-4 text-slate-400">{run.duplicate_source_ids ?? 0}</td>
                      <td className="py-3 px-4 text-slate-300 text-[11px]">
                        {run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)} ث` : '—'}
                      </td>
                      <td className="py-3 px-4 text-slate-400 text-[11px]">
                        {new Date(run.started_at).toLocaleTimeString('ar-EG')}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
};
