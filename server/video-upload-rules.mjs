const WECHAT_VIDEO_PIXEL_FORMATS = new Set(["yuv420p", "yuvj420p"]);

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function canFastRemuxWechatVideo(probe, maxEdge = 1920) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const videoStreams = streams.filter((stream) => stream?.codec_type === "video");
  if (videoStreams.length !== 1) return false;

  const video = videoStreams[0];
  const width = positiveInteger(video?.width);
  const height = positiveInteger(video?.height);
  const edgeLimit = positiveInteger(maxEdge);
  if (!width || !height || !edgeLimit || Math.max(width, height) > edgeLimit) return false;
  if (String(video?.codec_name ?? "").toLowerCase() !== "h264") return false;
  if (!WECHAT_VIDEO_PIXEL_FORMATS.has(String(video?.pix_fmt ?? "").toLowerCase())) return false;

  return streams
    .filter((stream) => stream?.codec_type === "audio")
    .every((stream) => String(stream?.codec_name ?? "").toLowerCase() === "aac");
}

export function normalizeVideoTranscodePreset(value, fallback = "superfast") {
  const allowed = new Set([
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
  ]);
  const normalized = String(value ?? "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}
