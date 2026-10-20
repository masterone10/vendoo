import React, { useState, useEffect } from 'react';
import { Archive, CheckCircle2, AlertTriangle, XCircle, Clock, RefreshCw, Play, ShieldCheck, Flame, Snowflake } from 'lucide-react';
import { safeFetchJson } from '../utils/api';

export const ArchiveView: React.FC = () => {
  const [coverageRecords, setCoverageRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [backfillingDate, setBackfillingDate] = useState<string>('');
  const [backfillingDomain, setBackfillingDomain] = useState<'orders' | 'logs'>('orders');
  const [isBackfilling, setIsBackfilling] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchCoverage();
  }, []);

  async function fetchCoverage() {
    setLoading(true);
    try {
      const { ok, data } = await safeFetchJson<{ coverage: any[] }>('/api/historical/coverage');
      if (ok && data) {
        setCoverageRecords(data.coverage || []);
      }
    } catch (err) {
      console.error('Error fetching coverage:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleTriggerBackfill() {
    if (!backfillingDate) return;
    setIsBackfilling(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/historical/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: backfillingDate,
          sourceDomain: backfillingDomain,
        }),
      });
      const data = await res.json();
      setActionMessage(data.message || 'تم بدء عملية الاسترجاع وتحديث الأرشيف');
      await fetchCoverage();
    } catch (err: any) {
      setActionMessage(`خطأ: ${err.message}`);
    } finally {
      setIsBackfilling(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto font-['Cairo',sans-serif]" dir="rtl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-stone-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-stone-100 flex items-center gap-2">
            <Archive className="w-5 h-5 text-amber-400" />
            <span>الأرشيف التاريخي ونطاق التغطية (Historical Archive & Coverage)</span>
          </h2>
          <p className="text-xs text-stone-400 mt-1">
            سجل دقيق لمدى اكتمال البيانات المؤرشفة لكل يوم تشغيلي، تقسيم البيانات الساخنة (HOT) والباردة (COLD)، واسترجاع الأيام السابقة
          </p>
        </div>

        <button
          onClick={fetchCoverage}
          disabled={loading}
          className="px-3 py-1.5 bg-stone-900 border border-stone-800 hover:bg-stone-800 text-stone-300 text-xs rounded-lg flex items-center gap-2 transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>تحديث التغطية</span>
        </button>
      </div>

      {/* On-Demand Historical Backfill Tool */}
      <div className="p-5 rounded-xl bg-stone-900/90 border border-stone-800 space-y-4">
        <h3 className="text-sm font-bold text-stone-100 flex items-center gap-2">
          <Play className="w-4 h-4 text-emerald-400" />
          <span>استرجاع أرشيف يوم محدد حسب الطلب (On-Demand Backfill)</span>
        </h3>
        <p className="text-xs text-stone-400">
          في حال وجود يوم تشغيلي غير مكتمل الأرشفة، يمكنك تشغيل استرجاع مصدري مباشر للطلبات أو السجلات
        </p>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <div>
            <label className="text-[11px] text-stone-400 block mb-1">تاريخ اليوم المراد استرجاعه:</label>
            <input
              type="date"
              value={backfillingDate}
              onChange={(e) => setBackfillingDate(e.target.value)}
              className="bg-stone-950 border border-stone-800 rounded-lg px-3 py-1.5 text-xs text-stone-200"
            />
          </div>

          <div>
            <label className="text-[11px] text-stone-400 block mb-1">نطاق الاسترجاع:</label>
            <select
              value={backfillingDomain}
              onChange={(e) => setBackfillingDomain(e.target.value as any)}
              className="bg-stone-950 border border-stone-800 rounded-lg px-3 py-1.5 text-xs text-stone-200"
            >
              <option value="orders">الطلبات (Orders)</option>
              <option value="logs">سجلات الأنشطة (Logs)</option>
            </select>
          </div>

          <div className="self-end">
            <button
              onClick={handleTriggerBackfill}
              disabled={isBackfilling || !backfillingDate}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-stone-950 font-bold text-xs rounded-lg flex items-center gap-2 transition-colors cursor-pointer shadow-sm"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isBackfilling ? 'animate-spin' : ''}`} />
              <span>{isBackfilling ? 'جاري الاسترجاع والتحقق...' : 'بدء الاسترجاع المصدري'}</span>
            </button>
          </div>
        </div>

        {actionMessage && (
          <div className="p-3 bg-stone-950 border border-stone-800 rounded-lg text-xs text-stone-300">
            {actionMessage}
          </div>
        )}
      </div>

      {/* Coverage Table */}
      <div className="bg-stone-900/90 border border-stone-800 rounded-xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-stone-800 flex items-center justify-between">
          <span className="text-sm font-bold text-stone-100">سجل التغطية اليومية للأيام المسجلة</span>
          <span className="text-xs text-stone-400 font-mono">إجمالي التواريخ: {coverageRecords.length}</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-right text-xs">
            <thead className="bg-stone-950/80 border-b border-stone-800 text-stone-400 font-medium">
              <tr>
                <th className="py-3 px-4">تاريخ التشغيل (YYYY-MM-DD)</th>
                <th className="py-3 px-4">نطاق البيانات</th>
                <th className="py-3 px-4">طبقة التخزين (Tier)</th>
                <th className="py-3 px-4">الصفحات المقروءة</th>
                <th className="py-3 px-4">السجلات المحفوظة</th>
                <th className="py-3 px-4">حالة التغطية</th>
                <th className="py-3 px-4">آخر فحص</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-800/60 text-stone-200">
              {coverageRecords.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-stone-500">
                    لا توجد سجلات تغطية تاريخية مسجلة بعد
                  </td>
                </tr>
              ) : (
                coverageRecords.map((c: any) => (
                  <tr key={c.id || `${c.source_domain}-${c.period_date}`} className="hover:bg-stone-800/40 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-stone-100">
                      {c.period_date}
                    </td>
                    <td className="py-3 px-4 font-semibold text-stone-300">
                      {c.source_domain === 'orders' ? 'الطلبات (Orders)' : 'السجلات (Logs)'}
                    </td>
                    <td className="py-3 px-4">
                      {c.storage_tier === 'HOT' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-amber-500/15 text-amber-300 border border-amber-500/20">
                          <Flame className="w-3 h-3 text-amber-400" /> ساخنة (HOT)
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-sky-500/15 text-sky-300 border border-sky-500/20">
                          <Snowflake className="w-3 h-3 text-sky-400" /> مؤرشفة (COLD)
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-stone-300">
                      {c.pages_read} / {c.pages_discovered}
                    </td>
                    <td className="py-3 px-4 font-mono font-bold text-stone-100">
                      {c.records_saved}
                    </td>
                    <td className="py-3 px-4">
                      {c.completion_status === 'COMPLETE' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400 font-bold text-[11px]">
                          <CheckCircle2 className="w-3.5 h-3.5" /> مكتمل 100%
                        </span>
                      ) : c.completion_status === 'PARTIAL' ? (
                        <span className="inline-flex items-center gap-1 text-amber-400 font-bold text-[11px]">
                          <AlertTriangle className="w-3.5 h-3.5" /> جزئي
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-400 font-bold text-[11px]">
                          <XCircle className="w-3.5 h-3.5" /> غير مكتمل
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-stone-400">
                      {c.last_attempted_at ? new Date(c.last_attempted_at).toLocaleDateString('ar-EG') : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
