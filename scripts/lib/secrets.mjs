// Cross-platform secret storage for the Financy and CardCom credentials.
//
// Read order: process.env -> .env file in the project root -> macOS Keychain.
// Env vars win so CI and one-off runs can override; the .env file is what the
// setup skill writes on Linux/Windows; the Keychain is what it prefers on a
// Mac, where secrets never touch disk.
//
// The .env file is gitignored (.env* in .gitignore) and written chmod 600.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_PATH = join(ROOT, '.env');

// service-name mapping keeps Keychain entries compatible with an existing
// manual setup (security add-generic-password -s financy-client-id ...).
const KEYCHAIN_SERVICE = {
  FINANCY_CLIENT_ID: 'financy-client-id',
  FINANCY_CLIENT_SECRET: 'financy-client-secret',
  FINANCY_USER_ID: 'financy-user-id',
  CARDCOM_API_NAME: 'cardcom-api-name',
  CARDCOM_API_PASSWORD: 'cardcom-api-password',
};

function parseDotEnv(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function readDotEnv(path = ENV_PATH) {
  if (!existsSync(path)) return {};
  try { return parseDotEnv(readFileSync(path, 'utf8')); } catch { return {}; }
}

function readKeychain(service) {
  if (process.env.SECRETS_DISABLE_KEYCHAIN === '1') return null;
  if (process.platform !== 'darwin') return null;
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

export function getSecret(name, { envPath = ENV_PATH } = {}) {
  if (process.env[name]) return process.env[name];
  const fromFile = readDotEnv(envPath)[name];
  if (fromFile) return fromFile;
  const service = KEYCHAIN_SERVICE[name];
  return service ? readKeychain(service) : null;
}

// Used by the setup skill. Keychain on a Mac; .env (chmod 600) elsewhere.
export function saveSecret(name, value, { envPath = ENV_PATH } = {}) {
  const service = KEYCHAIN_SERVICE[name];
  if (process.platform === 'darwin' && service && process.env.SECRETS_DISABLE_KEYCHAIN !== '1') {
    execFileSync('security',
      ['add-generic-password', '-U', '-s', service, '-a', process.env.USER || 'user', '-w', value],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return 'keychain';
  }
  const cur = readDotEnv(envPath);
  cur[name] = value;
  const text = Object.entries(cur).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(envPath, text, 'utf8');
  chmodSync(envPath, 0o600);
  return 'env-file';
}

export { parseDotEnv, ENV_PATH };
