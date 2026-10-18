import React, { useState, useEffect } from 'react';
import { Database, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Server, Play, KeyRound, Clock, ShieldCheck, FileText, Calendar } from 'lucide-react';
import { SupabaseStatus } from '../types';

export const SettingsView: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<any>(null);
  const [supabaseStatus, setSupabaseStatus] = useState<SupabaseStatus | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<any>(null);
  const [triggeringBaseline, setTriggeringBaseline] = useState(false);
  const [baselineResult, setBaselineResult] = useState<any>(null);

  useEffect(() => {
    fetchSettings();
    fetchSupabaseStatus();
  }, []);

  async function fetchSettings() {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
      }
    } catch (err) {
      console.error('Error fetching settings:', err);
    }
  }

  async function fetchSupabaseStatus() {
    setLoading(true);
    try {
      const res = await fetch('/api/supabase/status');
      if (res.ok) {
        const data = await res.json();
        setSupabaseStatus(data);
      }
    } catch (err) {
      console.error('Error fetching Supabase status:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleApplyMigration() {
    setMigrating(true);
    setMigrationResult(null);
    try {
      const res = await fetch('/api/supabase/migrate', { method: 'POST' });
      const data = await res.json();
      setMigrationResult(data);
      await fetchSupabaseStatus();
      await fetchSettings();
    } catch (err: any) {
      setMigrationResult({ success: false, error: err.message });
    } finally {
      setMigrating(false);
    }
  }

  async function handleTriggerBaseline() {
    setTriggeringBaseline(true);
    setBaselineResult(null);
    try {
      const res = await fetch('/api/sync/trigger', { method: 'POST' });
      const data = await res.json();
      setBaselineResult(data);
      await fetchSupabaseStatus();
      await fetchSettings();
    } catch (err: any) {
      setBaselineResult({ success: false, error: err.message });
    } finally {
      setTriggeringBaseline(false);
    }
  }

  const isConfigured = supabaseStatus?.isConfigured;
  const isConnected = supabaseStatus?.isConnected;
  const isSchemaReady = isConnected && supabaseStatus?.missingTables?.length === 0;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto font-['Cairo',sans-serif]" dir="rtl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-stone-800 pb-4">
        <div>
          <h2 className="text-xl font-bold text-stone-100 flex items-center gap-2">
            <Database className="w-5 h-5 text-emerald-400" />
            <span>إعدادات قاعدة البيانات والربط المصدري (Supabase & Settings)</span>
          </h2>
          <p className="text-xs text-stone-400 mt-1">
            البدء التأسيسي المباشر على Supabase PostgreSQL اعتباراً من 17 أكتوبر 2026 دون ترحيل بيانات قديمة
          </p>
        </div>

        <button
          onClick={() => { fetchSettings(); fetchSupabaseStatus(); }}
          disabled={loading}
          className="px-3 py-1.5 bg-stone-900 border border-stone-800 text-stone-300 hover:text-stone-100 text-xs rounded-lg flex items-center gap-2 transition-colors cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>تحديث الحالة</span>
        </button>
      </div>

      {/* Fresh Baseline Notice Banner */}
      <div className="p-4 bg-emerald-500/10 border border-emerald-500/25 rounded-xl flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
          <Calendar className="w-5 h-5" />
        </div>
        <div className="text-xs text-stone-300">
          <span className="font-bold text-emerald-300 block mb-0.5">بدء التجميع المصدري والأرشفة الدائمة: 17 أكتوبر 2026</span>
          يبدأ النظام بتأسيس مسح شامل ومباشر لجميع حالات فيندور النشطة، وحفظ التاريخ والأنشطة اللحظية على Supabase PostgreSQL بصورة دائمة.
        </div>
      </div>

      {/* Supabase Authoritative Database Card */}
      <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-6 shadow-sm space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              isConnected ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400' : 'bg-amber-500/10 border border-amber-500/30 text-amber-400'
            }`}>
              <Server className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-stone-100">قاعدة بيانات Supabase PostgreSQL</h3>
                <span className={`text-[11px] px-2 py-0.5 rounded-full font-bold ${
                  isConnected
                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    : isConfigured
                      ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                      : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                }`}>
                  {isConnected ? 'متصل ومعتمد إنتاجياً' : isConfigured ? 'فشل الاتصال' : 'في انتظار تهيئة DATABASE_URL'}
                </span>
              </div>
              <p className="text-xs text-stone-400 mt-0.5 font-mono">
                {settings?.supabase?.url || 'DATABASE_URL غير مهيأ حالياً في Secrets'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleApplyMigration}
              disabled={migrating || !isConfigured}
              className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-stone-950 font-bold text-xs rounded-lg flex items-center gap-2 transition-all cursor-pointer shadow-sm"
            >
              <ShieldCheck className={`w-4 h-4 ${migrating ? 'animate-spin' : ''}`} />
              <span>{migrating ? 'جاري تطبيق المخطط...' : 'تطبيق الميجريشن (Apply Schema)'}</span>
            </button>

            <button
              onClick={handleTriggerBaseline}
              disabled={triggeringBaseline}
              className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-stone-950 font-bold text-xs rounded-lg flex items-center gap-2 transition-all cursor-pointer shadow-sm"
            >
              <Play className={`w-4 h-4 ${triggeringBaseline ? 'animate-spin' : ''}`} />
              <span>{triggeringBaseline ? 'جاري المسح التأسيسي...' : 'بدء المسح التأسيسي المباشر'}</span>
            </button>
          </div>
        </div>

        {/* Status Indicators */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="p-3.5 rounded-lg bg-stone-950/60 border border-stone-800 space-y-1">
            <span className="text-[11px] text-stone-400">الوضع التشغيلي</span>
            <div className="text-sm font-bold text-stone-100 flex items-center gap-1.5">
              {isConnected ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span className="text-emerald-400">Supabase PostgreSQL (المعتمد)</span>
                </>
              ) : (
                <>
                  <Clock className="w-4 h-4 text-amber-400" />
                  <span className="text-amber-400">في انتظار ربط DATABASE_URL</span>
                </>
              )}
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-stone-950/60 border border-stone-800 space-y-1">
            <span className="text-[11px] text-stone-400">زمن الاستجابة (Latency)</span>
            <div className="text-sm font-bold text-stone-100 font-mono">
              {supabaseStatus?.latencyMs !== null && supabaseStatus?.latencyMs !== undefined
                ? `${supabaseStatus.latencyMs} ms`
                : 'غير متاح'}
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-stone-950/60 border border-stone-800 space-y-1">
            <span className="text-[11px] text-stone-400">حالة الجداول (Schema)</span>
            <div className="text-sm font-bold text-stone-100">
              {supabaseStatus?.missingTables?.length === 0 ? (
                <span className="text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" /> كافة الجداول مهيأة (17 جدول)
                </span>
              ) : (
                <span className="text-amber-400 flex items-center gap-1">
                  <AlertTriangle className="w-4 h-4" /> {supabaseStatus?.missingTables?.length || 0} جداول متبقية
                </span>
              )}
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-stone-950/60 border border-stone-800 space-y-1">
            <span className="text-[11px] text-stone-400">القيد الفرعي لكود فيندور</span>
            <div className="text-sm font-bold text-stone-100">
              {supabaseStatus?.canonicalConstraintPresent ? (
                <span className="text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-4 h-4" /> مفعل (UNIQUE vendoor_id)
                </span>
              ) : (
                <span className="text-stone-400 flex items-center gap-1">
                  غير مفعل بعد
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Missing configuration notice banner if DATABASE_URL not set */}
        {!isConfigured && (
          <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-2">
            <div className="flex items-center gap-2 text-amber-400 font-bold text-sm">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>خطوة الربط: إعداد متغير DATABASE_URL في Google AI Studio Secrets</span>
            </div>
            <p className="text-xs text-stone-300 leading-relaxed">
              يرجى إضافة نص الاتصال (Connection URI) من لوحة تحكم Supabase (Settings &rarr; Database &rarr; Connection string URI - Transaction mode port 6543) كمتغير <code className="bg-stone-900 px-1.5 py-0.5 rounded text-amber-300 font-mono">DATABASE_URL</code> في إعدادات Secrets لخادم Google AI Studio.
            </p>
            <div className="text-xs text-stone-400 flex items-center gap-1 pt-1 font-mono">
              <FileText className="w-3.5 h-3.5 text-amber-400" />
              <span>راجع التفاصيل والخطوات في ملف: SUPABASE_SETUP.md</span>
            </div>
          </div>
        )}

        {/* Migration Result Box */}
        {migrationResult && (
          <div className={`p-4 rounded-xl border text-xs space-y-1 ${
            migrationResult.success
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}>
            <div className="font-bold flex items-center gap-2">
              {migrationResult.success ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
              <span>{migrationResult.message || (migrationResult.success ? 'تم تطبيق الميجريشن بنجاح' : 'فشل تطبيق الميجريشن')}</span>
            </div>
            {migrationResult.error && <p className="font-mono text-rose-400">{migrationResult.error}</p>}
          </div>
        )}

        {/* Baseline Trigger Result Box */}
        {baselineResult && (
          <div className="p-4 rounded-xl border border-stone-800 bg-stone-950 text-xs space-y-1 text-stone-200">
            <div className="font-bold text-emerald-400 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              <span>تم تشغيل دورة الفحص التأسيسي المصدري بنجاح</span>
            </div>
            <p className="text-[11px] text-stone-400">
              يقوم النظام الآن بمطابقة كافة طلبات فيندور من البداية وحتى أحدث التحديثات وحفظها في قاعدة البيانات السحابية.
            </p>
          </div>
        )}
      </div>

      {/* Vendoor Synchronization Credentials Card */}
      <div className="bg-stone-900/90 border border-stone-800 rounded-xl p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-stone-100">بيانات الاتصال بنظام فيندور المصدري</h3>
            <p className="text-xs text-stone-400">بيانات الاعتماد المشفرة على الخادم لقراءة العمليات وفحص المطابقة</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="p-3.5 rounded-lg bg-stone-950/60 border border-stone-800 space-y-1">
            <span className="text-stone-400 text-[11px]">البريد الإلكتروني للربط:</span>
            <div className="font-mono text-stone-200 font-bold">{settings?.authEmail || 'غير محدد'}</div>
          </div>
          <div className="p-3.5 rounded-lg bg-stone-950/60 border border-stone-800 space-y-1">
            <span className="text-stone-400 text-[11px]">رابط تسجيل الدخول المصدري:</span>
            <div className="font-mono text-stone-200 truncate">{settings?.loginUrl || 'https://aff.ven-door.com'}</div>
          </div>
          <div className="p-3.5 rounded-lg bg-stone-950/60 border border-stone-800 space-y-1">
            <span className="text-stone-400 text-[11px]">معدل دورة المزامنة:</span>
            <div className="font-mono text-stone-200 font-bold">{settings?.syncInterval || 300} ثانية</div>
          </div>
        </div>
      </div>
    </div>
  );
};
