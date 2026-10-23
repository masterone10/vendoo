import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDatabase } from './server/db.ts';
import { apiRouter } from './server/routes.ts';
import { syncEngine } from './server/syncEngine.ts';
import { startSupabaseArchiveWorker } from './server/supabaseArchiveWorker.ts';

// Safe environment loading: try dotenv first, fallback to Node 22 native loadEnvFile
try {
  const dotenv = await import('dotenv');
  dotenv.default?.config?.({ override: true });
} catch {
  try {
    // @ts-ignore Node 22 built-in env file loader
    process.loadEnvFile?.();
  } catch {
    // In production container environments, environment variables are directly injected
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const portArgIndex = process.argv.indexOf('--port');
const cliPort = portArgIndex !== -1 && process.argv[portArgIndex + 1] ? parseInt(process.argv[portArgIndex + 1], 10) : null;
const port = cliPort || (process.env.PORT ? parseInt(process.env.PORT, 10) : 3000);

app.use('/api/logs/upload-chunk', express.raw({ type: 'application/octet-stream', limit: '20mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Initialize SQLite database
initDatabase();

// Support /reports and /reports/* directly if requested without /api prefix
app.use('/reports', (req, res, next) => {
  req.url = '/reports' + req.url;
  apiRouter(req, res, next);
});

// Mount API routes
app.use('/api', apiRouter);

// Prevent unmatched /api and /reports routes from falling through to Vite HTML
app.use(['/api', '/reports'], (req, res) => {
  const requestId = crypto.randomUUID();
  res.status(404).json({
    success: false,
    error: {
      code: 'REPORT_ROUTE_NOT_FOUND',
      message: `مسار التقرير المطلوب '${req.originalUrl}' غير موجود (404)`,
      retryable: false,
      requestId,
    },
  });
});

// Global API error handler ensuring any exception returns standardized JSON instead of Express HTML
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestId = crypto.randomUUID();
  console.error(`[API Unhandled Error] [${requestId}]:`, err);
  if (!res.headersSent) {
    res.status(500).json({
      success: false,
      error: {
        code: 'REPORT_INTERNAL_ERROR',
        message: 'حدث خطأ داخلي في الخادم أثناء إنشاء بيانات التقرير',
        retryable: true,
        requestId,
      },
    });
  }
});

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    // Vite Dev Server middleware with HMR disabled to avoid WebSocket closed errors in AI Studio iframe
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve static frontend in production
    const distPath = fs.existsSync(path.resolve(__dirname, 'dist'))
      ? path.resolve(__dirname, 'dist')
      : path.resolve(__dirname, '../dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[Vendoor Intelligence Server] Running on http://localhost:${port}`);

    // Start background synchronization (responsive 45s interval for live tracking)
    const syncInterval = parseInt(process.env.SYNC_INTERVAL_SECONDS || '45', 10);
    syncEngine.start(syncInterval);

    // Start isolated Supabase background archive worker (separate 300s schedule, does not touch live counts)
    startSupabaseArchiveWorker(300);
  });
}

startServer().catch(err => {
  console.error('[Server Error]', err);
  process.exit(1);
});
