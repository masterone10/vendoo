import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Early Environment Loader for Vendoor Operations Intelligence
 * 
 * Ensures environment variables (from .env or process environment)
 * are loaded BEFORE any other application modules, databases, or services
 * evaluate their module-level configuration.
 */
let isEnvLoaded = false;

export function loadEnvironment(): void {
  if (isEnvLoaded) return;

  const cwd = process.cwd();
  const envPath = path.resolve(cwd, '.env');

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
  } else {
    dotenv.config({ override: true });
  }

  // Also support Node 22 built-in loadEnvFile if available
  try {
    // @ts-ignore
    if (typeof process.loadEnvFile === 'function' && fs.existsSync(envPath)) {
      // @ts-ignore
      process.loadEnvFile(envPath);
    }
  } catch {
    // Ignore fallback errors
  }

  isEnvLoaded = true;
}

// Auto-run on module evaluation
loadEnvironment();
