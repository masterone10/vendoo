import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { Sidebar, NavTab } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { PrintedView } from './components/PrintedView';
import { PendingProcessingView } from './components/PendingProcessingView';
import { OrdersView } from './components/OrdersView';
import { TeamView } from './components/TeamView';
import { AlertsView } from './components/AlertsView';
import { SyncHealthView } from './components/SyncHealthView';
import { ReportsView } from './components/ReportsView';
import { ComparisonView } from './components/ComparisonView';
import { LogsView } from './components/LogsView';
import { ArchiveView } from './components/ArchiveView';
import { SettingsView } from './components/SettingsView';
import { OrderDetailsModal } from './components/OrderDetailsModal';
import { useLiveUpdates } from './hooks/useLiveUpdates';
import { DashboardStats } from './types';
import { safeFetchJson } from './utils/api';

export default function App() {
  const cairoToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const urlParams = new URLSearchParams(window.location.search);
  const initialDate = urlParams.get('date') && /^\d{4}-\d{2}-\d{2}$/.test(urlParams.get('date')!)
    ? urlParams.get('date')!
    : cairoToday;

  const [selectedBusinessDate, setSelectedBusinessDate] = useState<string>(initialDate);
  const [currentTab, setCurrentTab] = useState<NavTab>('dashboard');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [selectedOrderCode, setSelectedOrderCode] = useState<string | null>(null);
  const [printedSubTab, setPrintedSubTab] = useState<'all' | 'no_extra_phone' | 'multi_merchant' | 'low_delivery'>('all');
  const [ordersStatusFilter, setOrdersStatusFilter] = useState<string>('all');
  const [isSyncingManual, setIsSyncingManual] = useState(false);

  const handleDateChange = useCallback((newDate: string) => {
    setSelectedBusinessDate(newDate);
    const url = new URL(window.location.href);
    url.searchParams.set('date', newDate);
    window.history.pushState({}, '', url.toString());
  }, []);

  const fetchStats = useCallback(async (dateToQuery?: string) => {
    const d = dateToQuery || selectedBusinessDate;
    const { ok, data } = await safeFetchJson<DashboardStats>(`/api/dashboard/stats?date=${d}`);
    if (ok && data) {
      setStats(data);
    }
  }, [selectedBusinessDate]);

  // Listen to live SSE events
  const { isConnected } = useLiveUpdates((event, payload) => {
    if (event === 'sync_completed' || event === 'status_changed' || event === 'new_alert') {
      fetchStats();
    }
  });

  useEffect(() => {
    fetchStats(selectedBusinessDate);
    const interval = setInterval(() => fetchStats(selectedBusinessDate), 10000);
    return () => clearInterval(interval);
  }, [fetchStats, selectedBusinessDate]);

  async function handleManualSync() {
    setIsSyncingManual(true);
    try {
      await fetch('/api/sync/trigger', { method: 'POST' });
      await fetchStats();
    } catch (err) {
      console.error('Error triggering manual sync:', err);
    } finally {
      setIsSyncingManual(false);
    }
  }

  // Dashboard card navigation helpers
  function handleFilterStatusFromDashboard(st: string) {
    if (st === 'Printed') {
      setPrintedSubTab('all');
      setCurrentTab('printed');
    } else if (st === 'Pending') {
      setCurrentTab('pending');
    } else if (st === 'Processing') {
      setCurrentTab('processing');
    } else {
      setOrdersStatusFilter(st);
      setCurrentTab('orders');
    }
  }

  function handleFilterConfirmationAge(ageCat: string) {
    setOrdersStatusFilter('Printed');
    setCurrentTab('printed');
  }

  function handleNavigateToPrintedTab(subTab: 'all' | 'no_extra_phone' | 'multi_merchant' | 'low_delivery') {
    setPrintedSubTab(subTab);
    setCurrentTab('printed');
  }

  const openAlertsCount = stats?.riskIndicators.openAlertsCount || 0;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-['Cairo',sans-serif]" dir="rtl">
      {/* Top Header with Global Date Control */}
      <Header
        syncStatus={stats?.syncStatus || null}
        isConnected={isConnected}
        onManualSync={handleManualSync}
        isSyncingManual={isSyncingManual}
        onNavigateToAlerts={() => setCurrentTab('alerts')}
        openAlertsCount={openAlertsCount}
        selectedDate={selectedBusinessDate}
        onDateChange={handleDateChange}
        storageTier={stats?.storageTier}
        coverageStatus={stats?.coverageStatus}
        databaseMode={stats?.databaseMode}
        onNavigateToSettings={() => setCurrentTab('settings')}
      />

      {/* Main Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Navigation Sidebar */}
        <Sidebar
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          openAlertsCount={openAlertsCount}
          printedCount={stats?.currentCounts.Printed}
          pendingCount={stats?.currentCounts.Pending}
          processingCount={stats?.currentCounts.Processing}
        />

        {/* Content View Container */}
        <main className="flex-1 overflow-y-auto bg-slate-950">
          {currentTab === 'dashboard' && (
            <DashboardView
              stats={stats}
              selectedDate={selectedBusinessDate}
              onFilterStatus={handleFilterStatusFromDashboard}
              onFilterConfirmationAge={handleFilterConfirmationAge}
              onNavigateToPrintedTab={handleNavigateToPrintedTab}
              onNavigateToPending={() => setCurrentTab('pending')}
              onNavigateToProcessing={() => setCurrentTab('processing')}
              onNavigateToAlerts={() => setCurrentTab('alerts')}
            />
          )}

          {currentTab === 'printed' && (
            <PrintedView
              initialSubTab={printedSubTab}
              onSelectOrder={(code) => setSelectedOrderCode(code)}
            />
          )}

          {currentTab === 'pending' && (
            <PendingProcessingView
              statusType="Pending"
              onSelectOrder={(code) => setSelectedOrderCode(code)}
            />
          )}

          {currentTab === 'processing' && (
            <PendingProcessingView
              statusType="Processing"
              onSelectOrder={(code) => setSelectedOrderCode(code)}
            />
          )}

          {currentTab === 'orders' && (
            <OrdersView
              initialStatus={ordersStatusFilter}
              selectedDate={selectedBusinessDate}
              onSelectOrder={(code) => setSelectedOrderCode(code)}
            />
          )}

          {currentTab === 'team' && (
            <TeamView
              selectedDate={selectedBusinessDate}
              onSelectOrder={(code) => setSelectedOrderCode(code)}
            />
          )}

          {currentTab === 'reports' && (
            <ReportsView onSelectOrder={(code) => setSelectedOrderCode(code)} />
          )}

          {currentTab === 'comparison' && (
            <ComparisonView />
          )}

          {currentTab === 'logs' && (
            <LogsView
              onSelectOrder={(code) => setSelectedOrderCode(code)}
              selectedDate={selectedBusinessDate}
            />
          )}

          {currentTab === 'alerts' && (
            <AlertsView onSelectOrder={(code) => setSelectedOrderCode(code)} />
          )}

          {currentTab === 'archive' && (
            <ArchiveView />
          )}

          {currentTab === 'sync_health' && (
            <SyncHealthView
              syncStatus={stats?.syncStatus || null}
              onManualSync={handleManualSync}
              isSyncingManual={isSyncingManual}
            />
          )}

          {currentTab === 'settings' && (
            <SettingsView />
          )}
        </main>
      </div>

      {/* Order Details Modal / Drawer */}
      <OrderDetailsModal
        orderCode={selectedOrderCode}
        onClose={() => setSelectedOrderCode(null)}
      />
    </div>
  );
}
