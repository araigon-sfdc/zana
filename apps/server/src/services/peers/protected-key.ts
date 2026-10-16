import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { serializePeerStorage, type PeerKeyProvider } from './peer-auth.js';

/** Injected by trusted host composition, never by HTTP or plugin code. */
export interface PeerCryptoProvider {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export const PEER_BOOT_KEY_ENV = 'ZCC_PEER_STORAGE_BOOT_KEY';
const MAX_KEY_FILE_BYTES = 4096;

export function createProtectedPeerKeyProvider(dataDir: string, cryptoProvider?: PeerCryptoProvider): PeerKeyProvider {
  return {
    getKey: async () => {
      let base: string;
      try { base = await realpath(dataDir); }
      catch { throw new Error('protected peer storage key unavailable'); }
      return serializePeerStorage(join(base, 'peer-key'), async () => {
        try {
        if (!cryptoProvider?.isEncryptionAvailable()) return null;
        const backend = cryptoProvider.getSelectedStorageBackend?.();
        if (backend === 'basic_text' || backend === 'unknown' || (process.platform === 'linux' &&
          !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend ?? ''))) return null;
        const baseInfo = await lstat(base);
        if (!baseInfo.isDirectory() || baseInfo.uid !== process.getuid?.() || (baseInfo.mode & 0o022) !== 0) throw new Error();
        const directory = join(base, 'peer-key');
        await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.uid !== baseInfo.uid || (info.mode & 0o7777) !== 0o700) throw new Error();
        const entries = await opendir(directory), stale: string[] = [];
        let count = 0;
        for await (const entry of entries) {
          if (++count > 32) throw new Error();
          if (entry.name === 'key.bin') continue;
          if (!entry.isFile() || !/^key-[0-9a-f-]{36}\.tmp$/.test(entry.name)) throw new Error();
          stale.push(join(directory, entry.name));
        }
        for (const path of stale) await unlink(path);
        const path = join(directory, 'key.bin');
        const read = async (): Promise<Buffer | null> => {
          let handle;
          try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
          try {
            const metadata = await handle.stat();
            if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== baseInfo.uid ||
              (metadata.mode & 0o7777) !== 0o600 || metadata.size < 1 || metadata.size > MAX_KEY_FILE_BYTES) throw new Error();
            const bytes = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
            let length = 0;
            while (length < bytes.length) {
              const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
              if (!bytesRead) break;
              length += bytesRead;
            }
            if (length !== metadata.size) throw new Error();
            return bytes.subarray(0, length);
          } finally { await handle.close(); }
        };
        let sealed = await read();
        if (!sealed) {
          // Losing an established key must not silently reset encrypted pair authority.
          const pairs = await lstat(join(base, 'peer-pairs')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
          if (pairs) throw new Error();
          const key = randomBytes(32);
          try { sealed = cryptoProvider.encryptString(key.toString('base64url')); }
          finally { key.fill(0); }
          if (!sealed.length || sealed.length > MAX_KEY_FILE_BYTES) throw new Error();
          const temporary = join(directory, `key-${randomUUID()}.tmp`);
          try {
            const handle = await open(temporary, 'wx', 0o600);
            try { await handle.writeFile(sealed); await handle.sync(); } finally { await handle.close(); }
            // Publish without replacing another host process's complete key.
            await link(temporary, path).catch(error => { if (error.code !== 'EEXIST') throw error; });
          } finally { await unlink(temporary).catch(() => {}); }
          const handle = await open(directory, constants.O_RDONLY);
          try { await handle.sync(); } finally { await handle.close(); }
          sealed = await read();
        }
        if (!sealed) throw new Error();
        const text = cryptoProvider.decryptString(sealed);
        if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw new Error();
        const key = Buffer.from(text, 'base64url');
        if (key.length !== 32 || key.toString('base64url') !== text) { key.fill(0); throw new Error(); }
        return key;
        } catch { throw new Error('protected peer storage key unavailable'); }
      });
    }
  };
}

/** Existing boot-only utility env seam; scrub before any plugin worker can inherit it. */
export function consumePeerBootKey(env: NodeJS.ProcessEnv = process.env): PeerKeyProvider & { dispose(): void } {
  const text = env[PEER_BOOT_KEY_ENV];
  delete env[PEER_BOOT_KEY_ENV];
  const key = text && /^[A-Za-z0-9_-]{43}$/.test(text) ? Buffer.from(text, 'base64url') : null;
  let live = !!key && key.length === 32 && key.toString('base64url') === text;
  return {
    getKey: async () => live ? Buffer.from(key!) : null,
    dispose: () => { live = false; key?.fill(0); }
  };
}
