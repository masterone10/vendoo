import React from 'react';
import { RefreshCw, ShieldAlert, Wifi, WifiOff, Layers, Calendar, ChevronRight, ChevronLeft } from 'lucide-react';
import { SyncStatus } from '../types';

interface HeaderProps {
  syncStatus: SyncStatus | null;
  isConnected: boolean;
  onManualSync: () => void;
  isSyncingManual: boolean;
  onNavigateToAlerts: () => void;
  openAlertsCount: number;
  selectedDate: string;
  onDateChange: (date: string) => void;
  storageTier?: 'HOT' | 'COLD';
  coverageStatus?: string;
}

export const Header: React.FC<HeaderProps> = ({
  syncStatus,
  isConnected,
  onManualSync,
  isSyncingManual,
  onNavigateToAlerts,
  openAlertsCount,
  selectedDate,
  onDateChange,
  storageTier = 'HOT',
  coverageStatus,
}) => {
  // Format last sync time in Cairo locale
  const lastSyncText = syncStatus?.lastSuccessfulSyncAt
    ? new Date(syncStatus.lastSuccessfulSyncAt).toLocaleTimeString('ar-EG', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : 'جاري الاتصال...';

  // Compute Cairo today
  const cairoToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const isToday = selectedDate === cairoToday;

  function shiftDay(days: number) {
    const [y, m, d] = selectedDate.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d) + days * 24 * 60 * 60 * 1000);
    onDateChange(dateObj.toISOString().slice(0, 10));
  }

  return (
    <header className="h-16 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-30">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-100 flex items-center gap-2">
              <span>عمليات فيندور الذكية</span>
              <span className="text-xs font-normal text-slate-400">| Vendoor Intelligence</span>
            </h1>
            <p className="text-xs text-slate-400">نظام مستقل للتحقق المصدري وكشف المخاطر التشغيلية</p>
          </div>
        </div>
      </div>

      {/* GLOBAL BUSINESS DATE CONTROL (Requirement: Single Source of Truth for selectedBusinessDate) */}
      <div className="flex items-center gap-2 bg-slate-950/80 border border-slate-800 rounded-lg px-2.5 py-1.5 shadow-inner">
        <Calendar className="w-4 h-4 text-amber-400" />
        <span className="text-xs text-slate-400 font-medium">تاريخ التشغيل:</span>

        {/* Previous Day Button */}
        <button
          onClick={() => shiftDay(-1)}
          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          title="اليوم السابق"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>

        {/* Date Input */}
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => e.target.value && onDateChange(e.target.value)}
          className="bg-slate-900 border border-slate-700/80 text-slate-200 text-xs rounded px-2 py-0.5 font-mono focus:outline-none focus:border-amber-500"
        />

        {/* Next Day Button */}
        <button
          onClick={() => shiftDay(1)}
          className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          title="اليوم التالي"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>

        {/* Jump to Today Button */}
        {!isToday && (
          <button
            onClick={() => onDateChange(cairoToday)}
            className="text-[11px] px-2 py-0.5 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/30 rounded font-medium transition-colors"
          >
            اليوم
          </button>
        )}

        {/* Storage Tier Badge */}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-bold uppercase tracking-wider ${
            storageTier === 'HOT'
              ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
              : 'bg-sky-500/15 text-sky-400 border border-sky-500/30'
          }`}
          title={storageTier === 'HOT' ? 'بيانات نشطة (اليوم + آخر 29 يوماً)' : 'أرشيف تاريخي بارد (أقدم من 30 يوماً)'}
        >
          {storageTier}
        </span>
      </div>

      <div className="flex items-center gap-4">
        {/* Connection & Sync Status Indicator */}
        <div className="hidden sm:flex items-center gap-2.5 text-xs text-slate-300 bg-slate-950/60 border border-slate-800 px-3 py-1.5 rounded-md">
          {isConnected ? (
            <span className="flex items-center gap-1.5 text-emerald-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <Wifi className="w-3.5 h-3.5" />
              <span>متصل بالمصدر</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-rose-400">
              <WifiOff className="w-3.5 h-3.5" />
              <span>انقطع الاتصال</span>
            </span>
          )}

          <span className="text-slate-600">·</span>
          <span className="text-slate-400">آخر مزامنة: {lastSyncText}</span>
          
          {syncStatus?.currentPhase && syncStatus.currentPhase !== 'IDLE' && (
            <>
              <span className="text-slate-600">·</span>
              <span className="text-amber-400 animate-pulse font-medium">
                {syncStatus.currentPhase === 'SCANNING_ORDERS' && 'مسح الطلبات...'}
                {syncStatus.currentPhase === 'PROCESSING_ORDERS' && 'معالجة وتدقيق...'}
                {syncStatus.currentPhase === 'SYNCING_CONFIRMATION_AGES' && 'فئات التأكيد...'}
                {syncStatus.currentPhase === 'SYNCING_SYSTEM_LOGS' && 'سجلات النظام...'}
                {syncStatus.currentPhase === 'ENRICHING_CUSTOMERS' && 'بيانات العملاء...'}
              </span>
            </>
          )}
        </div>

        {/* Critical Alerts Button */}
        <button
          onClick={onNavigateToAlerts}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md border transition-all ${
            openAlertsCount > 0
              ? 'bg-rose-500/10 border-rose-500/40 text-rose-300 hover:bg-rose-500/20 shadow-sm shadow-rose-950'
              : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'
          }`}
        >
          <ShieldAlert className={`w-4 h-4 ${openAlertsCount > 0 ? 'text-rose-400 animate-bounce' : 'text-slate-400'}`} />
          <span>تنبيهات التجار</span>
          {openAlertsCount > 0 && (
            <span className="bg-rose-600 text-white font-bold px-1.5 py-0.2 rounded text-[11px] leading-tight">
              {openAlertsCount}
            </span>
          )}
        </button>

        {/* Manual Sync Button */}
        <button
          onClick={onManualSync}
          disabled={isSyncingManual || (syncStatus?.currentPhase !== 'IDLE' && syncStatus?.currentPhase !== undefined)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 font-semibold text-xs rounded-md transition-colors shadow-sm cursor-pointer disabled:cursor-not-allowed"
          title="مزامنة فورية كاملة مع Vendoor"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isSyncingManual ? 'animate-spin' : ''}`} />
          <span>{isSyncingManual ? 'جاري الفحص...' : 'مزامنة الآن'}</span>
        </button>
      </div>
    </header>
  );
};
