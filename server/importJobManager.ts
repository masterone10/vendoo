import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { importBatchLogFiles, type BatchImportResult } from './batchLogsImporter.ts';

const TEMP_DIR = path.resolve(process.cwd(), 'data', 'temp_uploads');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

export const MAX_FILE_SIZE_BYTES = 150 * 1024 * 1024; // 150 MB

export interface ImportJobState {
  jobId: string;
  status: 'UPLOADING' | 'PARSING' | 'EXTRACTING_DATES' | 'SAVING_RECORDS' | 'COMPLETED' | 'FAILED';
  stageLabelAr: string;
  fileName: string;
  fileSizeBytes: number;
  uploadedBytes: number;
  uploadPercent: number;
  chunksReceived: number;
  totalChunks: number;
  rowsRead: number;
  rowsTotal: number;
  validRecords: number;
  savedCount: number;
  duplicatesCount: number;
  unparseableRows: number;
  unmatchedOrders: number;
  discoveredDatesCount: number;
  result: BatchImportResult | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const activeJobs = new Map<string, ImportJobState>();
let mostRecentJobId: string | null = null;

export function getImportJob(jobId: string): ImportJobState | null {
  return activeJobs.get(jobId) || null;
}

export function getActiveOrRecentJob(): ImportJobState | null {
  if (!mostRecentJobId) return null;
  return activeJobs.get(mostRecentJobId) || null;
}

export interface ChunkUploadParams {
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  fileName: string;
  fileSize: number;
  chunkBuffer: Buffer;
}

/**
 * Handles incoming chunk of a large log file.
 * Automatically assembles file and triggers processing job upon final chunk.
 */
export async function handleLogUploadChunk(params: ChunkUploadParams): Promise<{
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  isComplete: boolean;
  jobId?: string;
}> {
  const { uploadId, chunkIndex, totalChunks, fileName, fileSize, chunkBuffer } = params;

  if (fileSize > MAX_FILE_SIZE_BYTES) {
    throw new Error(`حجم الملف (${Math.round(fileSize / (1024 * 1024))}MB) يتجاوز الحد الأقصى المسموح به (150MB).`);
  }

  const cleanUploadId = uploadId.replace(/[^a-zA-Z0-9_\-]/g, '');
  const uploadDir = path.join(TEMP_DIR, cleanUploadId);
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const chunkPath = path.join(uploadDir, `part_${String(chunkIndex).padStart(6, '0')}`);
  fs.writeFileSync(chunkPath, chunkBuffer);

  const nowIso = new Date().toISOString();
  let job = activeJobs.get(cleanUploadId);
  if (!job) {
    job = {
      jobId: cleanUploadId,
      status: 'UPLOADING',
      stageLabelAr: 'جاري رفع أجزاء الملف إلى السيرفر...',
      fileName,
      fileSizeBytes: fileSize,
      uploadedBytes: 0,
      uploadPercent: 0,
      chunksReceived: 0,
      totalChunks,
      rowsRead: 0,
      rowsTotal: 0,
      validRecords: 0,
      savedCount: 0,
      duplicatesCount: 0,
      unparseableRows: 0,
      unmatchedOrders: 0,
      discoveredDatesCount: 0,
      result: null,
      errorMessage: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
    };
    activeJobs.set(cleanUploadId, job);
    mostRecentJobId = cleanUploadId;
  }

  job.chunksReceived++;
  job.uploadedBytes += chunkBuffer.length;
  job.uploadPercent = Math.min(100, Math.round((job.chunksReceived / totalChunks) * 100));
  job.updatedAt = nowIso;

  const isComplete = job.chunksReceived >= totalChunks;

  if (isComplete) {
    // Assemble all chunk parts into final file
    const safeBaseName = path.basename(fileName).replace(/[^a-zA-Z0-9_.\-\u0600-\u06FF]/g, '_');
    const assembledFilePath = path.join(TEMP_DIR, `${cleanUploadId}_${safeBaseName}`);
    const writeStream = fs.createWriteStream(assembledFilePath);

    for (let i = 0; i < totalChunks; i++) {
      const partFile = path.join(uploadDir, `part_${String(i).padStart(6, '0')}`);
      if (fs.existsSync(partFile)) {
        const partData = fs.readFileSync(partFile);
        writeStream.write(partData);
      }
    }
    writeStream.end();

    // Clean up parts dir
    try {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    } catch {}

    // Launch background asynchronous processing
    processAssembledFileJob(job, assembledFilePath, fileName).catch((err) => {
      console.error(`[ImportJob] Job ${cleanUploadId} failed:`, err);
    });
  }

  return {
    uploadId: cleanUploadId,
    chunkIndex,
    totalChunks,
    isComplete,
    jobId: cleanUploadId,
  };
}

async function processAssembledFileJob(
  job: ImportJobState,
  assembledFilePath: string,
  originalFileName: string
): Promise<void> {
  const nowIso = new Date().toISOString();
  job.status = 'PARSING';
  job.stageLabelAr = 'جاري قراءة الملف واكتشاف الأعمدة والتواريخ...';
  job.updatedAt = nowIso;

  try {
    const result = await importBatchLogFiles(
      [
        {
          fileName: originalFileName,
          filePath: assembledFilePath,
        },
      ],
      `job_${job.jobId.slice(0, 8)}`,
      (progress) => {
        job.status = progress.stage;
        job.stageLabelAr = progress.stageLabelAr;
        job.rowsRead = progress.rowsRead;
        job.rowsTotal = progress.rowsTotal;
        job.validRecords = progress.rowsRead - progress.unparseableRows;
        job.savedCount = progress.savedCount;
        job.duplicatesCount = progress.duplicatesCount;
        job.unparseableRows = progress.unparseableRows;
        job.discoveredDatesCount = progress.datesDiscovered;
        job.updatedAt = new Date().toISOString();
      }
    );

    job.status = result.success ? 'COMPLETED' : 'FAILED';
    job.stageLabelAr = result.statusMessageAr;
    job.rowsRead = result.totalRowsRead;
    job.validRecords = result.validRecordsCount;
    job.savedCount = result.totalSaved;
    job.duplicatesCount = result.totalDuplicates;
    job.unparseableRows = result.unparseableRows;
    job.unmatchedOrders = result.unmatchedOrdersCount;
    job.discoveredDatesCount = result.discoveredDates.length;
    job.result = result;
    job.errorMessage = result.success ? null : result.statusMessageAr;
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
  } catch (err: any) {
    job.status = 'FAILED';
    job.stageLabelAr = `فشل الاستيراد: ${err.message}`;
    job.errorMessage = err.message || 'حدث خطأ غير متوقع أثناء معالجة الملف';
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
  } finally {
    // Delete temp assembled file safely
    try {
      if (fs.existsSync(assembledFilePath)) {
        fs.unlinkSync(assembledFilePath);
      }
    } catch {}
  }
}
