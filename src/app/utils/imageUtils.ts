/**
 * 将文件读取为 base64 dataURL，超过 10MB 自动压缩。
 * @param file      上传的图片文件
 * @param maxBytes  超过此字节数则触发压缩（默认 10MB）
 * @param quality   首次压缩质量（0-1），不足时逐步降低
 * @param maxPx     单边最大像素，超过则缩放（默认 2400px）
 */
export function readAndCompressImage(
  file: File,
  maxBytes = 10 * 1024 * 1024,
  quality = 0.85,
  maxPx = 2400,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error("文件读取失败"));

    reader.onload = (evt) => {
      const dataUrl = evt.target?.result as string;

      // 未超限，直接返回
      if (file.size <= maxBytes) {
        resolve(dataUrl);
        return;
      }

      // 超限 → 用 Canvas 压缩
      const img = new Image();
      img.onerror = () => reject(new Error("图片加载失败"));
      img.onload = () => {
        let { width, height } = img;

        // 按比例缩小至 maxPx 以内
        if (width > maxPx || height > maxPx) {
          if (width >= height) {
            height = Math.round((height / width) * maxPx);
            width = maxPx;
          } else {
            width = Math.round((width / height) * maxPx);
            height = maxPx;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, width, height);

        // 逐步降低质量直到 ≤ maxBytes（最低 0.4）
        let q = quality;
        let result = canvas.toDataURL("image/jpeg", q);

        while (result.length * 0.75 > maxBytes && q > 0.4) {
          q = Math.max(q - 0.1, 0.4);
          result = canvas.toDataURL("image/jpeg", q);
        }

        resolve(result);
      };
      img.src = dataUrl;
    };

    reader.readAsDataURL(file);
  });
}
