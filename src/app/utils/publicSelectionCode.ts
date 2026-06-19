const PUBLIC_SELECTION_CODE_PREFIX = "MFISH";

function encodeBase64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string) {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes).trim();
  } catch {
    return "";
  }
}

export function buildPublicSelectionCode(stockItemId?: string) {
  const normalized = String(stockItemId ?? "").trim();
  if (!normalized) return "";
  return `${PUBLIC_SELECTION_CODE_PREFIX}-${encodeBase64Url(normalized)}`;
}

export function parsePublicSelectionCode(value?: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];

  const compact = raw.replace(/\s+/g, "");
  const embeddedCode = raw.match(/MFISH[-:][A-Za-z0-9_-]+/i)?.[0]?.replace(/\s+/g, "");
  const direct = embeddedCode || compact;
  const candidates = new Set<string>([raw, compact, direct]);
  const upper = direct.toUpperCase();

  if (upper.startsWith(`${PUBLIC_SELECTION_CODE_PREFIX}-`) || upper.startsWith(`${PUBLIC_SELECTION_CODE_PREFIX}:`)) {
    const token = direct.slice(PUBLIC_SELECTION_CODE_PREFIX.length + 1);
    const decoded = decodeBase64Url(token);
    if (decoded) candidates.add(decoded);
  }

  return [...candidates].map((candidate) => candidate.trim()).filter(Boolean);
}
