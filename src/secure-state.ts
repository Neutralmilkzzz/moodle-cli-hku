import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic-write.js";
import { createDefaultCredentialStore } from "./mcp/credentials/node-store.js";
import { createEncryptionKeyring, decryptValue, encryptValue } from "./worker/crypto.js";

export interface SecureStateOptions {
  homeDir?: string;
  encryptionKey?: () => Promise<string>;
}

export interface SecureStateFile {
  version: 1;
  encrypted_state: string;
}

export function secureStatePath(name: string, homeDir = homedir()): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(name)) {
    throw new Error("Secure state names may contain only lowercase letters, digits, underscores and hyphens.");
  }
  return join(homeDir, ".config", "hku-cli", "state", `${name}.json`);
}

/**
 * HKU service sessions contain bearer tokens and SSO cookies. They use the
 * same OS-protected key material as the existing local Moodle cache, with the
 * encrypted payload kept in a separate file.
 */
export async function readSecureState<T>(
  name: string,
  options: SecureStateOptions = {},
): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(secureStatePath(name, options.homeDir), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }

  try {
    const value = JSON.parse(raw) as Partial<SecureStateFile>;
    if (value.version !== 1 || typeof value.encrypted_state !== "string") return null;
    const keyring = await createEncryptionKeyring(await localEncryptionKey(options));
    const decrypted = await decryptValue(value.encrypted_state, keyring);
    return JSON.parse(decrypted.value) as T;
  } catch {
    return null;
  }
}

export async function writeSecureState<T>(
  name: string,
  state: T,
  options: SecureStateOptions = {},
): Promise<void> {
  const keyring = await createEncryptionKeyring(await localEncryptionKey(options));
  const encrypted: SecureStateFile = {
    version: 1,
    encrypted_state: await encryptValue(JSON.stringify(state), keyring),
  };
  const target = secureStatePath(name, options.homeDir);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFileAtomic(target, `${JSON.stringify(encrypted)}\n`, { mode: 0o600, directoryMode: 0o700 });
  await chmod(target, 0o600);
}

export async function deleteSecureState(
  name: string,
  options: SecureStateOptions = {},
): Promise<void> {
  await rm(secureStatePath(name, options.homeDir), { force: true });
}

const pendingKeys = new Map<string, Promise<string>>();

async function localEncryptionKey(options: SecureStateOptions): Promise<string> {
  if (options.encryptionKey) return options.encryptionKey();
  const home = options.homeDir ?? homedir();
  let pending = pendingKeys.get(home);
  if (!pending) {
    pending = (async () => {
      const store = createDefaultCredentialStore({ homeDirectory: home });
      const profile = `local-cache-${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
      const existing = await store.read(profile);
      if (existing) return existing.sessionEncryptionKey;
      const sessionEncryptionKey = randomBytes(32).toString("base64url");
      await store.write(profile, { mcpAccessToken: "", sessionSyncToken: "", sessionEncryptionKey });
      return sessionEncryptionKey;
    })();
    pendingKeys.set(home, pending);
    pending.catch(() => pendingKeys.delete(home));
  }
  return pending;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
