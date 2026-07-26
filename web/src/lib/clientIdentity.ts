// Random browser-profile pseudonym for mutating AgentGlass requests.
//
// No fingerprint inputs. No hardware IDs. No browsing history. The value only
// gives the server a stable handle for this browser profile until site storage
// is cleared. The server stores a one-way fingerprint, never this raw secret.
const STORAGE_KEY = "agentglass_client_token";

function makeToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function clientIdentityHeaders(): Record<string, string> {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return {};
  try {
    let token = localStorage.getItem(STORAGE_KEY);
    if (!token) {
      token = makeToken();
      localStorage.setItem(STORAGE_KEY, token);
    }
    return { "x-agentglass-client-token": token };
  } catch {
    return {};
  }
}
