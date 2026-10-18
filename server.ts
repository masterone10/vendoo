import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { initDatabase } from './server/db.js';
import { apiRouter } from './server/routes.js';
import { syncEngine } from './server/syncEngine.js';
import { startSupabaseArchiveWorker } from './server/supabaseArchiveWorker.js';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// Initialize SQLite database
initDatabase();

// Mount API routes
app.use('/api', apiRouter);

// Prevent unmatched /api routes from falling through to Vite HTML
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// Start background synchronization (responsive 45s interval for live tracking)
const syncInterval = parseInt(process.env.SYNC_INTERVAL_SECONDS || '45', 10);
syncEngine.start(syncInterval);

// Start isolated Supabase background archive worker (separate 300s schedule, does not touch live counts)
startSupabaseArchiveWorker(300);

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    // Vite Dev Server middleware
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve static frontend in production
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[Vendoor Intelligence Server] Running on http://localhost:${port}`);
  });
}

startServer().catch(err => {
  console.error('[Server Error]', err);
  process.exit(1);
});
