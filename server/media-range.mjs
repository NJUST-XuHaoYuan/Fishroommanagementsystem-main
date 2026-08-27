const singleByteRangePattern = /^bytes=(\d*)-(\d*)$/i;

export function normalizeSingleByteRange(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { present: false, valid: true, value: "" };
  if (raw.length > 128 || raw.includes(",")) {
    return { present: true, valid: false, value: "" };
  }
  const match = raw.match(singleByteRangePattern);
  if (!match || (!match[1] && !match[2])) {
    return { present: true, valid: false, value: "" };
  }
  const start = match[1];
  const end = match[2];
  if (start && end && BigInt(start) > BigInt(end)) {
    return { present: true, valid: false, value: "" };
  }
  return {
    present: true,
    valid: true,
    value: `bytes=${start}-${end}`,
  };
}

export function upstreamHeader(headers, name) {
  const normalizedName = String(name ?? "").toLowerCase();
  const entry = Object.entries(headers ?? {}).find(([key]) => String(key).toLowerCase() === normalizedName);
  return entry?.[1] == null ? "" : String(entry[1]);
}

export function cosObjectDelivery({
  bodyLength,
  cacheControl,
  contentLength,
  contentType,
  extraHeaders = {},
  range = "",
  upstreamHeaders = {},
  upstreamStatusCode,
}) {
  const contentRange = upstreamHeader(upstreamHeaders, "content-range");
  const isPartial = Boolean(range) && (Number(upstreamStatusCode) === 206 || Boolean(contentRange));
  const explicitLength = contentLength == null || contentLength === "" ? Number.NaN : Number(contentLength);
  const resolvedLength = Number.isFinite(explicitLength)
    ? Math.max(0, explicitLength)
    : Math.max(0, Number(bodyLength) || 0);
  const headers = {
    "Content-Type": contentType,
    "Content-Length": String(resolvedLength),
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
    ...extraHeaders,
  };
  if (contentRange) headers["Content-Range"] = contentRange;
  const etag = upstreamHeader(upstreamHeaders, "etag");
  if (etag) headers.ETag = etag;
  const lastModified = upstreamHeader(upstreamHeaders, "last-modified");
  if (lastModified) headers["Last-Modified"] = lastModified;
  return {
    statusCode: isPartial ? 206 : 200,
    headers,
  };
}
