import { getCACertificates, setDefaultCACertificates } from "node:tls";

let trusted = false;

/**
 * HKUL omits an intermediate certificate on its first TLS handshake. Node's
 * bundled roots alone therefore reject a certificate browsers accept. Loading
 * the OS trust store preserves normal hostname and chain verification.
 */
export function trustSystemCertificates(): void {
  if (trusted) return;
  const read = (getCACertificates as unknown as ((type: "system") => string[]) | undefined);
  const write = (setDefaultCACertificates as unknown as ((certificates: string[]) => void) | undefined);
  if (typeof read === "function" && typeof write === "function") {
    write(read("system"));
  }
  trusted = true;
}
