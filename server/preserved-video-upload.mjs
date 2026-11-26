import { open } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const videoCodecs = new Set(["h264", "hevc", "av1", "vp8", "vp9", "mpeg4", "h263"]);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

export function preserveOriginalVideoRequested(value, isVideo) {
  if (value === undefined) return false;
  if (value !== "1" || !isVideo) fail("仅视频支持保留原文件，请重新选择视频上传");
  return true;
}

export function summarizePreservedVideo(probe, mime) {
  const formats = String(probe?.format?.format_name || "").split(",");
  const webm = mime === "video/webm";
  if (!(webm ? formats.includes("webm") : formats.includes("mov") || formats.includes("mp4"))) {
    fail("视频文件格式与上传类型不符，请重新拍摄或选择原视频");
  }
  const videos = (Array.isArray(probe?.streams) ? probe.streams : [])
    .filter(stream => stream?.codec_type === "video" && !stream?.disposition?.attached_pic);
  if (videos.length !== 1) fail("视频文件无有效画面或包含多个画面轨道，请重新选择");
  const video = videos[0];
  const width = Number(video.width), height = Number(video.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 ||
      width > 8192 || height > 8192 || width * height > 35_389_440 || !videoCodecs.has(video.codec_name)) {
    fail("视频编码或分辨率不受支持，请选择不超过 8K 的常用格式视频");
  }
  const rawDuration = probe?.format?.duration ?? video.duration;
  const duration = Number(rawDuration);
  // MediaRecorder WebM commonly omits duration; its first frame is decoded below.
  const unknownDuration = rawDuration == null || rawDuration === "N/A";
  if ((!unknownDuration && (!Number.isFinite(duration) || duration <= 0 || duration > 7200)) ||
      (unknownDuration && !webm)) fail("视频时长无效或超过两小时，请重新拍摄或剪短后上传");
  const rotationValue = video.side_data_list?.find(item => item.side_data_type === "Display Matrix")?.rotation ?? video.tags?.rotate ?? 0;
  const rotation = Number(rotationValue) || 0;
  const rotated = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return {
    width: rotated ? height : width, height: rotated ? width : height,
    encodedWidth: width, encodedHeight: height,
    durationSeconds: unknownDuration ? null : duration,
    codec: video.codec_name,
  };
}

/** Validate a local upload before preserving its exact bytes. Never resolve external media protocols. */
export async function inspectPreservedVideoFile(filePath, mime, {
  ffprobePath = "ffprobe", ffmpegPath = "ffmpeg", timeoutMs = 30_000,
} = {}) {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const validSignature = mime === "video/webm"
      ? header.readUInt32BE(0) === 0x1a45dfa3
      : header.subarray(4, 8).toString("ascii") === "ftyp";
    if (bytesRead < 12 || !validSignature) fail("视频文件内容无效，请重新拍摄或选择原视频");
  } finally { await handle.close(); }
  const options = { timeout: Math.min(Math.max(1000, timeoutMs), 30_000), maxBuffer: 2 * 1024 * 1024 };
  let metadata;
  try {
    const { stdout } = await runFile(ffprobePath, ["-v", "error", "-protocol_whitelist", "file,pipe", "-print_format", "json", "-show_streams", "-show_format", filePath], options);
    metadata = summarizePreservedVideo(JSON.parse(stdout), mime);
    // Probing headers alone would accept a damaged or empty video track.
    const { stdout: frame } = await runFile(ffmpegPath, ["-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-threads", "1", "-i", filePath,
      "-map", "0:v:0", "-frames:v", "1", "-an", "-f", "framehash", "-"], options);
    if (!frame.split("\n").some(line => /^\s*\d+,\s*\d+,/.test(line))) fail("视频画面无法读取，请重新拍摄后上传");
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code === "ENOENT") fail("服务器暂时无法校验原视频，请稍后重试", 503);
    if (error.killed || error.code === "ETIMEDOUT") fail("原视频校验超时，请剪短后重试", 503);
    fail("视频画面无法读取或文件已损坏，请重新拍摄后上传");
  }
  return metadata;
}
