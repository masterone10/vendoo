import React, { useState, useRef } from 'react';
import {
  X,
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Calendar,
  Layers,
  ArrowRight,
  Database,
  CloudCheck,
  RefreshCw,
  FileText,
} from 'lucide-react';
import { BatchImportResult, DiscoveredDaySummary } from '../types';

interface BatchLogsImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportSuccess?: (result: BatchImportResult) => void;
  onSelectDateForReport?: (date: string) => void;
}

export const BatchLogsImportModal: React.FC<BatchLogsImportModalProps> = ({
  isOpen,
  onClose,
  onImportSuccess,
  onSelectDateForReport,
}) => {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>('');
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [liveStats, setLiveStats] = useState<{ rowsRead: number; datesDiscovered: number; savedCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFiles(Array.from(e.target.files));
      setError(null);
      setResult(null);
      setProgressPercent(0);
      setLiveStats(null);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setSelectedFiles(Array.from(e.dataTransfer.files));
      setError(null);
      setResult(null);
      setProgressPercent(0);
      setLiveStats(null);
    }
  }

  async function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = reader.result as string;
        const base64 = res.split(',')[1] || res;
        resolve(base64);
      };
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    });
  }

  async function uploadChunkedFile(file: File): Promise<BatchImportResult> {
    const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const uploadId = `up_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const start = chunkIdx * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const chunkBlob = file.slice(start, end);
      const chunkArrayBuffer = await chunkBlob.arrayBuffer();

      const pct = Math.round(((chunkIdx + 1) / totalChunks) * 45); // first 45% is upload
      setProgressPercent(pct);
      setUploadProgress(`جاري رفع الملف المجزأ (${chunkIdx + 1}/${totalChunks}) — ${(file.size / (1024 * 1024)).toFixed(1)}MB...`);

      const res = await fetch('/api/logs/upload-chunk', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-upload-id': uploadId,
          'x-chunk-index': String(chunkIdx),
          'x-total-chunks': String(totalChunks),
          'x-file-name': encodeURIComponent(file.name),
          'x-file-size': String(file.size),
        },
        body: chunkArrayBuffer,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `فشل رفع الجزء ${chunkIdx + 1}`);
      }
    }

    // Polling job progress
    setUploadProgress('تم رفع الملف بنجاح، جاري قراءة الحركات وتحليل التواريخ...');
    setProgressPercent(50);

    return new Promise<BatchImportResult>((resolve, reject) => {
      const intervalTimer = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/logs/import-job/${uploadId}`);
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();
          if (!pollData.success || !pollData.job) return;

          const job = pollData.job;
          setUploadProgress(job.stageLabelAr || 'جاري معالجة الحركات...');
          if (job.rowsRead > 0) {
            setLiveStats({
              rowsRead: job.rowsRead,
              datesDiscovered: job.discoveredDatesCount || 0,
              savedCount: job.savedCount || 0,
            });
          }

          if (job.status === 'PARSING') {
            setProgressPercent(60);
          } else if (job.status === 'SAVING_RECORDS') {
            setProgressPercent(80);
          } else if (job.status === 'COMPLETED') {
            clearInterval(intervalTimer);
            setProgressPercent(100);
            if (job.result) {
              resolve(job.result);
            } else {
              reject(new Error('اكتملت المهمة دون إرجاع نتيجة'));
            }
          } else if (job.status === 'FAILED') {
            clearInterval(intervalTimer);
            reject(new Error(job.errorMessage || 'فشلت معالجة الملف'));
          }
        } catch (e: any) {
          // ignore transient poll errors
        }
      }, 1000);
    });
  }

  async function handleStartImport() {
    if (selectedFiles.length === 0) {
      setError('يرجى اختيار ملف Excel أو CSV واحد على الأقل');
      return;
    }

    setIsUploading(true);
    setError(null);
    setResult(null);
    setProgressPercent(5);
    setLiveStats(null);
    setUploadProgress('جاري تحضير الملفات وقراءتها...');

    try {
      // If single file or large file (> 2.5 MB), use chunked uploader with live polling
      const isAnyLarge = selectedFiles.some(f => f.size > 2.5 * 1024 * 1024);
      if (selectedFiles.length === 1 || isAnyLarge) {
        let finalResult: BatchImportResult | null = null;
        for (let i = 0; i < selectedFiles.length; i++) {
          const f = selectedFiles[i];
          finalResult = await uploadChunkedFile(f);
        }
        if (finalResult) {
          setResult(finalResult);
          onImportSuccess?.(finalResult);
        }
      } else {
        // Direct batch upload for small files
        const payloadFiles: Array<{ fileName: string; base64: string }> = [];
        for (let i = 0; i < selectedFiles.length; i++) {
          const f = selectedFiles[i];
          setUploadProgress(`جاري قراءة ${f.name} (${i + 1}/${selectedFiles.length})...`);
          const base64 = await fileToBase64(f);
          payloadFiles.push({ fileName: f.name, base64 });
        }

        setUploadProgress('جاري إرسال البيانات وتقسيم الأيام وحفظها في SQLite...');
        setProgressPercent(60);

        const res = await fetch('/api/logs/import-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: payloadFiles }),
        });

        const data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || data.result?.statusMessageAr || 'فشل استيراد الملفات');
        }

        setProgressPercent(100);
        setResult(data.result);
        onImportSuccess?.(data.result);
      }
    } catch (err: any) {
      setError(err.message || 'حدث خطأ أثناء معالجة ملفات اللوجز');
    } finally {
      setIsUploading(false);
      setUploadProgress('');
    }
  }

  function handleReset() {
    setSelectedFiles([]);
    setResult(null);
    setError(null);
    setProgressPercent(0);
    setLiveStats(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-800 bg-slate-800/40">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-500/10 border border-blue-500/20 rounded-xl text-blue-400">
              <FileSpreadsheet className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">استيراد لوجز تاريخية متعددة الأيام (Excel / CSV)</h2>
              <p className="text-sm text-slate-400">
                رفع ملفات تحركات فيندور دفعة واحدة، اكتشاف الأيام تلقائياً، ومنع التكرار مع الحفظ المزدوج
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {error && (
            <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl flex items-start gap-3 text-rose-300">
              <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">خطأ في الاستيراد</p>
                <p className="text-sm text-rose-300/90">{error}</p>
              </div>
            </div>
          )}

          {!result ? (
            <>
              {/* File Dropzone */}
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-slate-700 hover:border-blue-500/60 bg-slate-800/20 hover:bg-slate-800/40 rounded-2xl p-8 text-center cursor-pointer transition-all"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".xlsx,.xls,.csv"
                  onChange={handleFilesChange}
                  className="hidden"
                />
                <div className="w-16 h-16 mx-auto mb-4 bg-blue-500/10 border border-blue-500/20 rounded-2xl flex items-center justify-center text-blue-400">
                  <Upload className="w-8 h-8" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-1">
                  اسحب وأفلت ملفات Excel أو CSV هنا، أو انقر للاختيار
                </h3>
                <p className="text-sm text-slate-400 max-w-md mx-auto">
                  يدعم صيغ <span className="text-slate-300 font-mono">.xlsx, .xls, .csv</span> ويقوم تلقائياً بتحديد أعمدة (كود الطلب، اسم الموظف، نص الحركة، وقت الحركة).
                </p>
              </div>

              {/* Selected Files List */}
              {selectedFiles.length > 0 && (
                <div className="bg-slate-800/50 border border-slate-700/60 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-semibold text-slate-300">
                      الملفات المختارة ({selectedFiles.length}):
                    </span>
                    <button
                      onClick={handleReset}
                      className="text-xs text-slate-400 hover:text-rose-400 transition-colors"
                    >
                      إلغاء التحديد
                    </button>
                  </div>
                  <div className="space-y-2 max-h-36 overflow-y-auto">
                    {selectedFiles.map((file, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between text-xs bg-slate-900/60 border border-slate-800 px-3 py-2 rounded-lg"
                      >
                        <div className="flex items-center gap-2 text-slate-200">
                          <FileText className="w-4 h-4 text-blue-400 shrink-0" />
                          <span className="font-medium truncate max-w-md">{file.name}</span>
                        </div>
                        <span className="text-slate-400">{(file.size / 1024).toFixed(1)} KB</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Instructions Info Card */}
              <div className="bg-slate-800/30 border border-slate-700/40 rounded-xl p-4 flex items-start gap-3 text-xs text-slate-400">
                <HelpCircle className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold text-slate-300">قواعد الاستيراد والتعامل التاريخي:</p>
                  <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                    <li>يتم فرز وتقسيم الحركات حسب يوم حدوثها (بتوقيت القاهرة) تلقائياً.</li>
                    <li>تسجيل كل يوم في سجل التغطية اليومي مع وسم المصدر <code className="text-blue-300">EXCEL_IMPORT</code> لمنع إعادة سحبه تلقائياً.</li>
                    <li>تطبيق بصمة فريدة بنسبة 100% لمنع تكرار أي حركة سابقة أو تكرار رفع الملف.</li>
                    <li>الحفظ فوري في SQLite مع مزامنة وتحقق تلقائي في Supabase عند توافره.</li>
                  </ul>
                </div>
              </div>
            </>
          ) : (
            /* Result Summary View */
            <div className="space-y-6">
              {/* Top KPI Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-800/50 border border-slate-700/60 p-4 rounded-xl">
                  <span className="text-xs text-slate-400 block mb-1">الأيام المكتشفة</span>
                  <span className="text-2xl font-bold text-blue-400">{result.discoveredDates.length}</span>
                </div>
                <div className="bg-slate-800/50 border border-slate-700/60 p-4 rounded-xl">
                  <span className="text-xs text-slate-400 block mb-1">إجمالي الحركات المقروءة</span>
                  <span className="text-2xl font-bold text-white">{result.totalRowsRead.toLocaleString()}</span>
                </div>
                <div className="bg-slate-800/50 border border-emerald-500/20 bg-emerald-500/5 p-4 rounded-xl">
                  <span className="text-xs text-emerald-300 block mb-1">الحركات الجديدة المحفوظة</span>
                  <span className="text-2xl font-bold text-emerald-400">{result.totalSaved.toLocaleString()}</span>
                </div>
                <div className="bg-slate-800/50 border border-amber-500/20 bg-amber-500/5 p-4 rounded-xl">
                  <span className="text-xs text-amber-300 block mb-1">المكررة (تم تخطيها)</span>
                  <span className="text-2xl font-bold text-amber-400">{result.totalDuplicates.toLocaleString()}</span>
                </div>
              </div>

              {/* Discovered Dates Breakdown Table */}
              <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl overflow-hidden">
                <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-blue-400" />
                    <h4 className="font-bold text-white text-sm">سجل الأيام المكتشفة وتغطيتها</h4>
                  </div>
                  <span className="text-xs text-slate-400">
                    رقم الدفعة: <code className="text-slate-300 font-mono">{result.batchId}</code>
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="bg-slate-800/80 text-slate-400 border-b border-slate-700/60">
                        <th className="p-3">التاريخ</th>
                        <th className="p-3">حركات الملف</th>
                        <th className="p-3">الجديد المحفوظ</th>
                        <th className="p-3">المكرر</th>
                        <th className="p-3">حركات اليوم الكلية</th>
                        <th className="p-3">حالة اليوم</th>
                        <th className="p-3">أرشيف Supabase</th>
                        <th className="p-3 text-center">الإجراء</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 text-slate-200">
                      {result.discoveredDates.map((day: DiscoveredDaySummary) => (
                        <tr key={day.date} className="hover:bg-slate-800/30 transition-colors">
                          <td className="p-3 font-mono font-medium text-blue-300">{day.date}</td>
                          <td className="p-3">{day.rowsCount.toLocaleString()}</td>
                          <td className="p-3 text-emerald-400 font-semibold">{day.savedCount.toLocaleString()}</td>
                          <td className="p-3 text-amber-400">{day.duplicatesCount.toLocaleString()}</td>
                          <td className="p-3 font-semibold">{day.canonicalCount.toLocaleString()}</td>
                          <td className="p-3">
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-blue-500/10 text-blue-300 border border-blue-500/20">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              مستورد من ملف
                            </span>
                          </td>
                          <td className="p-3">
                            {day.remoteArchiveStatus === 'REMOTE_VERIFIED' ? (
                              <span className="inline-flex items-center gap-1 text-emerald-400 text-[11px]">
                                <CloudCheck className="w-3.5 h-3.5" />
                                مؤكد سحابياً
                              </span>
                            ) : day.remoteArchiveStatus === 'REMOTE_SYNCED' ? (
                              <span className="text-blue-400 text-[11px]">مُرسل لسوبابيز</span>
                            ) : (
                              <span className="text-slate-400 text-[11px]">محلي فقط</span>
                            )}
                          </td>
                          <td className="p-3 text-center">
                            {onSelectDateForReport && (
                              <button
                                onClick={() => {
                                  onSelectDateForReport(day.date);
                                  onClose();
                                }}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 transition-colors"
                              >
                                عرض التقرير
                                <ArrowRight className="w-3 h-3" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Warnings if any */}
              {result.warnings.length > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/20 p-4 rounded-xl text-xs space-y-1 text-amber-300">
                  <p className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    ملاحظات الاستيراد:
                  </p>
                  <ul className="list-disc list-inside space-y-0.5 text-amber-200/80">
                    {result.warnings.map((w, idx) => (
                      <li key={idx}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-800/40 flex flex-col md:flex-row items-center justify-between gap-4">
          {!result ? (
            <>
              <div className="w-full md:w-auto flex-1 text-xs text-slate-400 space-y-1.5">
                {uploadProgress ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2 text-blue-400 font-medium">
                        <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                        {uploadProgress}
                      </span>
                      <span className="text-blue-300 font-mono font-semibold">{progressPercent}%</span>
                    </div>
                    {/* Visual Progress Bar */}
                    <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="bg-gradient-to-r from-blue-500 to-emerald-400 h-1.5 rounded-full transition-all duration-300"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                    {liveStats && liveStats.rowsRead > 0 && (
                      <div className="flex items-center gap-3 text-[11px] text-slate-400">
                        <span>تمت قراءة: <strong className="text-white">{liveStats.rowsRead.toLocaleString()}</strong></span>
                        <span>•</span>
                        <span>أيام مكتشفة: <strong className="text-blue-300">{liveStats.datesDiscovered}</strong></span>
                        <span>•</span>
                        <span>حركات جديدة: <strong className="text-emerald-400">{liveStats.savedCount.toLocaleString()}</strong></span>
                      </div>
                    )}
                  </>
                ) : (
                  <span>جاهز للاستيراد</span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={onClose}
                  disabled={isUploading}
                  className="px-4 py-2 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 text-sm transition-colors"
                >
                  إلغاء
                </button>
                <button
                  onClick={handleStartImport}
                  disabled={selectedFiles.length === 0 || isUploading}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium text-sm transition-all shadow-lg shadow-blue-600/20"
                >
                  {isUploading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      جاري المعالجة...
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4" />
                      بدء استيراد اللوجز
                    </>
                  )}
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-between w-full">
              <button
                onClick={handleReset}
                className="px-4 py-2 rounded-xl text-slate-300 hover:text-white hover:bg-slate-800 text-sm transition-colors"
              >
                استيراد ملفات أخرى
              </button>
              <button
                onClick={onClose}
                className="px-5 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-colors"
              >
                إغلاق
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
