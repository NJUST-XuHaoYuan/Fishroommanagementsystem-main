import {
  useCallback,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type Dispatch,
  type DragEvent as ReactDragEvent,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import { originalMediaKind, uploadOriginalMedia } from "./media";

type RecordMediaDraft = {
  photos: string[];
  videos: string[];
};

type UploadSource = "picker" | "clipboard" | "drop";
type ExpectedMediaKind = "image" | "video" | undefined;

function transferFiles(data: DataTransfer): File[] {
  const directFiles = Array.from(data.files ?? []);
  if (directFiles.length > 0) return directFiles;
  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function hasFilePayload(data: DataTransfer) {
  return data.files.length > 0
    || Array.from(data.types ?? []).includes("Files")
    || Array.from(data.items ?? []).some((item) => item.kind === "file");
}

function uploadedLabel(photoCount: number, videoCount: number) {
  return [
    photoCount > 0 ? `${photoCount} 张照片` : "",
    videoCount > 0 ? `${videoCount} 个视频` : "",
  ].filter(Boolean).join("、");
}

export function useRecordMediaUpload<T extends RecordMediaDraft>(
  setDraft: Dispatch<SetStateAction<T>>,
  enabled = true,
) {
  const [pendingCount, setPendingCount] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);

  const uploadFiles = useCallback(async (
    input: ArrayLike<File> | Iterable<File> | null,
    expectedKind?: ExpectedMediaKind,
    source: UploadSource = "picker",
  ) => {
    if (!input) return;
    const files = Array.from(input);
    const accepted = files
      .map((file) => ({ file, kind: originalMediaKind(file) }))
      .filter((entry): entry is { file: File; kind: "image" | "video" } => (
        Boolean(entry.kind) && (!expectedKind || entry.kind === expectedKind)
      ));

    if (accepted.length === 0) {
      toast.error(expectedKind === "image" ? "请选择图片文件" : expectedKind === "video" ? "请选择视频文件" : "没有可上传的图片或视频文件");
      return;
    }
    if (accepted.length < files.length) {
      toast.info("已忽略不支持的文件");
    }

    setPendingCount((count) => count + accepted.length);
    toast.info(source === "clipboard"
      ? "正在上传剪贴板中的媒体文件…"
      : source === "drop" ? "正在上传拖入的媒体文件…" : "媒体原文件上传中…");
    const results = await Promise.allSettled(
      accepted.map(async ({ file, kind }) => ({ kind, url: await uploadOriginalMedia(file) })),
    );

    const photos: string[] = [];
    const videos: string[] = [];
    let failedCount = 0;
    let firstError = "";
    results.forEach((result) => {
      if (result.status === "fulfilled") {
        if (result.value.kind === "image") photos.push(result.value.url);
        else videos.push(result.value.url);
        return;
      }
      failedCount += 1;
      if (!firstError) firstError = result.reason instanceof Error ? result.reason.message : "媒体上传失败，请重试";
    });

    if (photos.length > 0 || videos.length > 0) {
      setDraft((draft) => ({
        ...draft,
        photos: [...draft.photos, ...photos],
        videos: [...draft.videos, ...videos],
      }));
      const label = uploadedLabel(photos.length, videos.length);
      toast.success(source === "clipboard"
        ? `已粘贴并上传 ${label}`
        : source === "drop" ? `已拖入并上传 ${label}` : `已上传 ${label}`);
    }
    if (failedCount > 0) {
      toast.error(failedCount === 1 ? firstError : `${failedCount} 个文件上传失败：${firstError}`);
    }
    setPendingCount((count) => Math.max(0, count - accepted.length));
  }, [setDraft]);

  const pasteFiles = useCallback((event: ReactClipboardEvent<HTMLElement>) => {
    const files = transferFiles(event.clipboardData)
      .filter((file) => originalMediaKind(file));
    if (files.length === 0) return;
    event.preventDefault();
    void uploadFiles(files, undefined, "clipboard");
  }, [uploadFiles]);

  const onDragEnter = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current += 1;
    if (enabled) setIsDragging(true);
  }, [enabled]);

  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = enabled ? "copy" : "none";
  }, [enabled]);

  const onDragLeave = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (dragDepth.current === 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setIsDragging(false);
    if (!enabled) {
      toast.error("当前账号没有添加记录的权限");
      return;
    }
    void uploadFiles(transferFiles(event.dataTransfer), undefined, "drop");
  }, [enabled, uploadFiles]);

  return {
    dropZoneProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
    isDragging,
    isUploading: pendingCount > 0,
    pasteFiles,
    uploadImages: (files: ArrayLike<File> | Iterable<File> | null) => uploadFiles(files, "image"),
    uploadVideos: (files: ArrayLike<File> | Iterable<File> | null) => uploadFiles(files, "video"),
  };
}
