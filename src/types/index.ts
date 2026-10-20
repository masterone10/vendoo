export interface OrderItem {
  id: number;
  order_id: number;
  vendoor_item_id: number | null;
  product_id: number | null;
  product_name: string;
  merchant_code: string | null;
  merchant_name?: string | null;
  warehouse_name?: string | null;
  warehouse_code?: string | null;
  code_source?: string | null;
  merchant_id: string | null;
  sku: string | null;
  size: string | null;
  color: string | null;
  quantity: number;
  unit_price: number;
  pay_vendor: number;
  image_path: string | null;
  created_at: string;
}

export interface Order {
  id: number;
  vendoor_id: number;
  random_number: string;
  order_no: string | null;
  order_type: string;
  current_status: 'New' | 'Pending' | 'Processing' | 'Printed' | 'Canceled' | string;
  affiliate_code: string;
  affiliate_name: string;
  customer_name: string;
  customer_phone: string;
  customer_phone_extra: string | null;
  extra_phone_valid: number;
  extra_phone_status?: 'NOT_RETRIEVED' | 'PRESENT' | 'CONFIRMED_ABSENT' | 'RETRIEVAL_FAILED' | string;
  governorate: string;
  address: string;
  address_quality_status?: 'VALID' | 'SHORT_ADDRESS' | 'LATIN_SCRIPT' | 'MISSING' | 'NOT_RETRIEVED' | string;
  total_price: number;
  shipping_cost: number;
  total_order: number;
  distinct_merchant_count: number;
  multi_merchant_flag: number;
  delivery_rate: number | null;
  delivery_rate_num: number | null;
  delivery_rate_denom: number | null;
  cancel_rate: number | null;
  total_customer_orders: number | null;
  phone_repetition_count: number | null;
  customer_last_order_status: string | null;
  customer_last_order_elapsed: string | null;
  customer_delivery_warning: string | null;
  confirmation_age_category: '1_day' | '2_days' | '3_days' | 'over_3_days' | null;
  printed_date: string | null;
  state_entry_at: string | null;
  created_at_source: string;
  last_observed_at: string;
  warehouseCodes?: string[];
  warehouseNames?: string[];
  merchantCodes?: string[];
}

export interface Alert {
  id: number;
  alert_key: string;
  order_id: number;
  random_number: string;
  alert_type: 'MULTIPLE_MERCHANT_CODES' | 'LOW_DELIVERY_RATE' | 'MISSING_EXTRA_PHONE' | 'INCOMPLETE_DATA';
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED';
  title: string;
  description: string;
  details_json: string | null;
  is_pre_existing: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_notes: string | null;
  customer_name?: string;
  customer_phone?: string;
  governorate?: string;
  total_order?: number;
  delivery_rate?: number;
}

export interface DashboardStats {
  selectedDate?: string;
  isToday?: boolean;
  storageTier?: 'HOT' | 'COLD';
  coverageStatus?: string;
  isCached?: boolean;
  currentCounts: {
    New: number;
    Pending: number;
    Processing: number;
    Canceling: number;
    Printed: number;
    Canceled: number;
  };
  confirmationAges: {
    '1_day': number;
    '2_days': number;
    '3_days': number;
    'over_3_days': number;
    isAvailable?: boolean;
    state?: 'SUCCESS' | 'PARTIAL' | 'STALE' | 'NOT_AVAILABLE';
    lastObservedAt?: string | null;
    lastSuccessAt?: string | null;
  };
  riskIndicators: {
    multiMerchantPrinted: number;
    lowDeliveryRatePrinted: number;
    missingExtraPhonePrinted: number;
    openAlertsCount: number;
  };
  todayActivity: {
    Created: number;
    Printed: number;
    Pending: number;
    Processing: number;
    Canceling: number;
    Canceled: number;
  };
  pendingAge: {
    lessThanTwoDays: number;
    twoToFourDays: number;
    fourToFiveDays: number;
    overFiveDays: number;
    unknown: number;
    total: number;
  };
  processingAge: {
    lessThanTwoDays: number;
    twoToFourDays: number;
    fourToFiveDays: number;
    overFiveDays: number;
    unknown: number;
    total: number;
  };
  syncStatus: SyncStatus;
  databaseMode?: 'SUPABASE_POSTGRES' | 'SQLITE_AWAITING_CONFIG';
  supabaseConfigured?: boolean;
}

export interface SupabaseStatus {
  isConfigured: boolean;
  isConnected: boolean;
  latencyMs: number | null;
  mode: 'SUPABASE_POSTGRES' | 'SQLITE_AWAITING_CONFIG';
  host?: string;
  database?: string;
  missingTables: string[];
  presentTables: string[];
  tableCounts: Record<string, number>;
  canonicalConstraintPresent: boolean;
  error?: string | null;
}

export interface SyncStatus {
  isRunning: boolean;
  cycleState?: 'IDLE' | 'QUEUED' | 'RUNNING' | 'PARTIAL' | 'SUCCESS' | 'ERROR';
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  nextScheduledRunAt?: string | null;
  currentPhase: string;
  totalOrdersInDb: number;
  totalAlertsOpen: number;
  lastError: string | null;
  consecutiveFailures: number;
  lastDurationMs?: number | null;
}

export interface TeamMember {
  name: string;
  actions: number;
  uniqueOrders: number;
  printed: number;
  pending: number;
  processing: number;
  cancel: number;
  other: number;
  printedPercent?: number;
  pendingPercent?: number;
  processingPercent?: number;
  cancelPercent?: number;
  otherPercent?: number;
}

export interface SystemLogEvent {
  id: number;
  raw_event_id: number | null;
  order_code: string | null;
  actor_name: string;
  action_type: string;
  action_label_ar?: string;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  note_text?: string | null;
  from_status: string | null;
  to_status: string | null;
  event_timestamp: string;
  storage_tier: 'HOT' | 'COLD';
  is_system_actor: number;
  created_at: string;
  imported_at?: string;
  raw_action_text: string;
  source_hash?: string;
  page_source?: string;
  vendoor_order_id?: number | null;
  order_id?: number | null;
  order_match_status?: 'MATCHED' | 'UNRESOLVED' | 'GENERAL_LOG';
  is_administrative?: number;
  details_json?: string | null;
  // Enriched order data if matched
  order_no?: string | null;
  order_current_status?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_phone_extra?: string | null;
  governorate?: string | null;
  order_address?: string | null;
  total_order?: number | null;
  affiliate_name?: string | null;
  affiliate_code?: string | null;
  distinct_merchant_count?: number | null;
  delivery_rate?: number | null;
  warehouseCodes?: string[];
}

export interface LogStats {
  total: number;
  todayLogs: number;
  activeEmployees: number;
  matchedWithOrders: number;
  administrativeLogs: number;
  unresolvedLogs: number;
  statusChangesCount: number;
  notesCount: number;
  addressEditsCount: number;
  phoneEditsCount: number;
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

export type FetchStage =
  | 'IDLE'
  | 'CHECKING_STORAGE'
  | 'FETCHING_VENDOOR'
  | 'SAVING_RECORDS'
  | 'ANALYZING_ACTIONS'
  | 'COMPUTING_METRICS'
  | 'PREPARING_REPORT'
  | 'COMPLETE'
  | 'PARTIAL'
  | 'FAILED';

export interface RangeJobState {
  startDate: string;
  endDate: string;
  stage: FetchStage;
  stageLabelAr: string;
  pagesFetched: number;
  pagesTotal: number;
  eventsSaved: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  loadedFromCache: boolean;
}

export interface LogsIntelligenceReport {
  startDate: string;
  endDate: string;
  periodType: 'day' | 'week' | 'custom';
  periodLabel: string;
  cairoInterval: {
    startCairo: string;
    endExclusiveCairo: string;
  };
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'FETCHING';
  loadedFromCache: boolean;
  lastVerifiedAt: string | null;
  coverage: {
    totalDays: number;
    completeDays: number;
    partialDays: number;
    failedDays: number;
    missingDays: number;
    pagesRead: number;
    recordsSaved: number;
    isFullyComplete: boolean;
    dataSource?: string;
    sourceSummary?: string;
  };
  metrics: {
    totalLogs: number;
    uniqueOrdersTouched: number;
    confirmedOrdersCount: number;
    printedEventsCount: number;
    canceledOrdersCount: number;
    canceledEventsCount: number;
    cancelingEventsCount: number;
    createdOrdersCount: number;
    createdEventsCount: number;
    extraPhonesAddedUniqueOrders: number;
    extraPhonesAddedEvents: number;
    extraPhonesReplacedCount: number;
    extraPhonesDeletedCount: number;
    statusChangeEventsCount: number;
    adminEditsCount: number;
    unresolvedCount: number;
  };
  days: Array<{
    date: string;
    dayNameAr: string;
    totalLogs: number;
    uniqueOrdersTouched: number;
    createdOrdersCount: number;
    confirmedOrdersCount: number;
    canceledOrdersCount: number;
    extraPhonesAddedCount: number;
    activeEmployeesCount: number;
    coverageStatus: string;
    dataSource?: string;
    localStorageStatus?: string;
    remoteArchiveStatus?: string;
  }>;
  employees: Array<{
    actor_name: string;
    is_system: number;
    actor_type: 'STAFF' | 'SYSTEM' | 'UNKNOWN';
    action_count: number;
    unique_orders: number;
    confirmed_orders_count: number;
    canceled_orders_count: number;
    extra_phones_added_count: number;
    status_changes_count: number;
    actions_breakdown: Record<string, number>;
  }>;
  transitions: Array<{
    from_status: string;
    to_status: string;
    events_count: number;
    unique_orders: number;
  }>;
  administrativeEdits: Array<{
    action_type: string;
    action_label_ar: string;
    field_name: string;
    events_count: number;
    unique_orders: number;
  }>;
  unresolvedActions: Array<{
    id: number;
    order_code: string | null;
    actor_name: string;
    raw_action_text: string;
    event_timestamp: string;
    action_type: string;
  }>;
  recentEvents: Array<{
    id: number;
    order_code: string | null;
    actor_name: string;
    action_type: string;
    from_status: string | null;
    to_status: string | null;
    raw_action_text: string;
    event_timestamp: string;
    field_name: string | null;
    old_value: string | null;
    new_value: string | null;
    is_system_actor: number;
  }>;
}

export interface HistoricalDayStatus {
  date: string;
  decision: string;
  dataSource: string;
  completionStatus: string;
  localStorageStatus: string;
  remoteArchiveStatus: string;
  rawRecordsCount: number;
  canonicalEventsCount: number;
  loadedFromCache: boolean;
  messageAr: string;
  lastAttemptedAt?: string | null;
  completedAt?: string | null;
  verifiedAt?: string | null;
  lastImportAt?: string | null;
  sourceFileNames?: string | null;
}

export interface DiscoveredDaySummary {
  date: string;
  rowsCount: number;
  savedCount: number;
  duplicatesCount: number;
  canonicalCount: number;
  coverageStatus: string;
  dataSource: string;
  remoteArchiveStatus: string;
}

export interface BatchImportResult {
  success: boolean;
  batchId: string;
  filesProcessed: string[];
  sheetsProcessed: string[];
  totalRowsRead: number;
  totalSaved: number;
  totalDuplicates: number;
  unparseableRows: number;
  discoveredDates: DiscoveredDaySummary[];
  reviewRows: Array<{
    fileName: string;
    sheetName: string;
    rowIndex: number;
    reason: string;
    sampleData: Record<string, any>;
  }>;
  warnings: string[];
}
