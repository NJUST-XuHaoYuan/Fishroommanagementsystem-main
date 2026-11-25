export const IMAGE_PASTE_HELP = "截图后，点击此处按 Ctrl+V / ⌘V 粘贴，也可选择图片上传。";

// Only consume actual image files, never clipboard HTML, text or remote URLs.
export function imageFilesFromTransfer(data: Pick<DataTransfer, "files" | "items">): File[] {
  const files = Array.from(data.files ?? []);
  const candidates = files.length ? files : Array.from(data.items ?? [])
    .filter(item => item.kind === "file")
    .map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
  return candidates.filter(file => file.type.startsWith("image/"));
}

export async function readClipboardImages(
  clipboard: Pick<Clipboard, "read"> | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard,
): Promise<File[]> {
  if (!clipboard?.read) throw new Error(`当前浏览器不支持直接读取截图。${IMAGE_PASTE_HELP}`);
  let items: ClipboardItem[];
  try { items = await clipboard.read(); }
  catch { throw new Error(`未能读取剪贴板，请允许浏览器读取，或${IMAGE_PASTE_HELP}`); }
  const files: File[] = [];
  for (const item of items) {
    // A single image can have several representations; upload it only once.
    const type = ["image/png", "image/jpeg", "image/webp"].find(type => item.types.includes(type))
      || item.types.find(type => type.startsWith("image/"));
    if (!type) continue;
    let blob: Blob;
    try { blob = await item.getType(type); }
    catch { throw new Error(`截图读取失败，请重新截图后粘贴。${IMAGE_PASTE_HELP}`); }
    const extension = type === "image/jpeg" ? "jpg" : type.split("/")[1].replace(/[^a-z0-9]/gi, "") || "png";
    files.push(new File([blob], `截图-${Date.now()}-${files.length + 1}.${extension}`, { type }));
  }
  if (!files.length) throw new Error("剪贴板中没有图片。请先截图并复制，再点击「粘贴截图」。");
  return files;
}
