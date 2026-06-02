import { useRef } from "react";
import { Button } from "./ui/button";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { Upload, X } from "lucide-react";
import { toast } from "sonner";
import { readAndCompressImage } from "../utils/imageUtils";

type Props = {
  value: string;
  onChange: (v: string) => void;
  size?: number;
};

export function ImageUpload({ value, onChange, size = 96 }: Props) {
  const ref = useRef<HTMLInputElement>(null);

  const pick = async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("请选择图片文件");
      return;
    }
    try {
      const needsCompress = file.size > 10 * 1024 * 1024;
      if (needsCompress) toast.info("图片较大，正在压缩…");
      const dataUrl = await readAndCompressImage(file);
      if (needsCompress) toast.success("压缩完成");
      onChange(dataUrl);
    } catch (e) {
      toast.error("图片处理失败，请重试");
    }
  };

  return (
    <div className="flex items-center gap-3">
      <div
        className="rounded-md overflow-hidden bg-muted border flex items-center justify-center"
        style={{ width: size, height: size }}
      >
        {value ? (
          <ImageWithFallback src={value} alt="" className="size-full object-cover" />
        ) : (
          <span className="text-xs text-muted-foreground">无图片</span>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <input
          ref={ref}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => ref.current?.click()}>
          <Upload className="size-4" /> {value ? "更换图片" : "上传图片"}
        </Button>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-red-600"
            onClick={() => onChange("")}
          >
            <X className="size-4" /> 移除
          </Button>
        )}
      </div>
    </div>
  );
}
