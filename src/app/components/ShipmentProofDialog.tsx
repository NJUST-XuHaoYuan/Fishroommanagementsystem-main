import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Camera, ChevronLeft, ChevronRight, Download, ExternalLink, Loader2 } from "lucide-react";
import type { Shipment } from "../store";
import { downloadMedia, useResolvedMediaUrl } from "../utils/media";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { toast } from "sonner";

function shipmentProofDate(shipment: Shipment): string {
  const raw = String(shipment.shippedAt || shipment.createdAt || shipment.shipDate || "").trim();
  if (!raw) return "时间未记录";
  const localMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (localMatch && !/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) {
    return `${localMatch[1]} ${localMatch[2]}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw.replace("T", " ").slice(0, 16);
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16).replace("T", " ");
}

function imageExtension(src: string): string {
  return src.match(/\.(jpe?g|png|webp|gif|heic|heif)(?:[?#]|$)/i)?.[1]?.toLowerCase() ?? "jpg";
}

export function shipmentPackingProofs(shipment?: Shipment | null): string[] {
  if (!Array.isArray(shipment?.packingProof)) return [];
  return shipment.packingProof.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function ShipmentProofImage({
  src,
  alt,
  onLoaded,
  onFailed,
}: {
  src: string;
  alt: string;
  onLoaded: (resolvedUrl: string) => void;
  onFailed: () => void;
}) {
  const resolvedSrc = useResolvedMediaUrl(src);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  if (status === "error") {
    return (
      <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center text-white/80">
        <AlertTriangle className="size-8 text-amber-400" />
        <div>
          <div className="font-medium text-white">该照片文件已损坏或无法读取</div>
          <div className="mt-1 text-xs text-white/60">历史记录仍保留，但原图内容无法恢复</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {status === "loading" && <Loader2 className="size-6 animate-spin text-white/70" />}
      {resolvedSrc && (
        <img
          src={resolvedSrc}
          alt={alt}
          className={`absolute inset-0 size-full object-contain ${status === "loaded" ? "opacity-100" : "opacity-0"}`}
          onLoad={() => {
            setStatus("loaded");
            onLoaded(resolvedSrc);
          }}
          onError={() => {
            setStatus("error");
            onFailed();
          }}
        />
      )}
    </>
  );
}

export function ShipmentProofDialog({
  shipment,
  orderNo,
  shipmentNumber,
  open,
  onOpenChange,
}: {
  shipment: Shipment | null;
  orderNo?: string;
  shipmentNumber?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const proofs = useMemo(() => shipmentPackingProofs(shipment), [shipment]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [activeImageUrl, setActiveImageUrl] = useState("");
  const [activeImageAvailable, setActiveImageAvailable] = useState(false);
  const boundedIndex = Math.min(activeIndex, Math.max(0, proofs.length - 1));
  const activeProof = proofs[boundedIndex];

  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      setDownloading(false);
    }
  }, [open, shipment?.id]);

  useEffect(() => {
    setActiveImageUrl("");
    setActiveImageAvailable(false);
  }, [activeProof]);

  if (!shipment) return null;

  const method = shipment.shipMethod === "pickup"
    ? "上门自取"
    : shipment.carrier || "物流发货";
  const shipmentName = shipmentNumber ? `发货单 ${shipmentNumber}` : "发货单";

  const downloadActiveProof = async () => {
    if (!activeProof) return;
    setDownloading(true);
    try {
      const safeOrderNo = (orderNo || shipment.orderId || "订单").replace(/[^a-zA-Z0-9_-]+/g, "-");
      await downloadMedia(
        activeProof,
        `${safeOrderNo}-发货凭证-${boundedIndex + 1}.${imageExtension(activeProof)}`,
        { mediaType: "image" },
      );
    } catch {
      toast.error("凭证下载失败，请刷新后重试");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="overflow-hidden p-0 sm:max-h-[92dvh] sm:max-w-4xl sm:p-0">
        <DialogHeader className="border-b px-4 pb-3 pt-4 pr-12 sm:px-5 sm:pb-4 sm:pt-5">
          <DialogTitle className="flex min-w-0 items-center gap-2 text-left">
            <Camera className="size-5 shrink-0 text-sky-700" />
            <span className="truncate">发货凭证{orderNo ? ` · ${orderNo}` : ""}</span>
          </DialogTitle>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{shipmentName}</span>
            <span>{method}</span>
            <span>{shipmentProofDate(shipment)}</span>
            <span>{proofs.length} 张照片</span>
          </div>
        </DialogHeader>

        {activeProof ? (
          <div className="min-h-0 overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-5 sm:pb-5">
            <div className="relative mt-4 flex h-[46dvh] min-h-60 items-center justify-center overflow-hidden rounded-md border bg-zinc-950 sm:h-[58vh]">
              <ShipmentProofImage
                key={activeProof}
                src={activeProof}
                alt={`发货凭证 ${boundedIndex + 1}`}
                onLoaded={(resolvedUrl) => {
                  setActiveImageUrl(resolvedUrl);
                  setActiveImageAvailable(true);
                }}
                onFailed={() => {
                  setActiveImageUrl("");
                  setActiveImageAvailable(false);
                }}
              />

              {proofs.length > 1 && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute left-2 size-10 bg-white/90 shadow hover:bg-white"
                    aria-label="上一张凭证"
                    onClick={() => setActiveIndex((boundedIndex - 1 + proofs.length) % proofs.length)}
                  >
                    <ChevronLeft className="size-5" />
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute right-2 size-10 bg-white/90 shadow hover:bg-white"
                    aria-label="下一张凭证"
                    onClick={() => setActiveIndex((boundedIndex + 1) % proofs.length)}
                  >
                    <ChevronRight className="size-5" />
                  </Button>
                </>
              )}

              <span className="absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-xs text-white">
                {boundedIndex + 1} / {proofs.length}
              </span>
            </div>

            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {proofs.map((proof, index) => (
                <button
                  key={`${proof}-${index}`}
                  type="button"
                  aria-label={`查看第 ${index + 1} 张凭证`}
                  aria-current={index === boundedIndex ? "true" : undefined}
                  className={`size-16 shrink-0 overflow-hidden rounded-md border-2 bg-muted transition-colors ${
                    index === boundedIndex ? "border-sky-700" : "border-transparent hover:border-slate-400"
                  }`}
                  onClick={() => setActiveIndex(index)}
                >
                  <ImageWithFallback src={proof} alt="" className="size-full object-cover" />
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <span className="text-sm text-muted-foreground">第 {boundedIndex + 1} 张，共 {proofs.length} 张</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!activeImageAvailable || !activeImageUrl}
                  onClick={() => activeImageUrl && window.open(activeImageUrl, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLink className="size-4" />
                  查看原图
                </Button>
                <Button type="button" variant="outline" disabled={downloading || !activeImageAvailable} onClick={downloadActiveProof}>
                  {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                  {downloading ? "下载中" : "下载当前照片"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="px-5 py-12 text-center text-sm text-muted-foreground">该发货单没有保存凭证照片</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
