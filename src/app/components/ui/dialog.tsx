"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";

import { cn } from "./utils";

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

const DialogTrigger = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>(({ ...props }, ref) => (
  <DialogPrimitive.Trigger ref={ref} data-slot="dialog-trigger" {...props} />
));
DialogTrigger.displayName = DialogPrimitive.Trigger.displayName;

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

const DialogClose = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ ...props }, ref) => (
  <DialogPrimitive.Close ref={ref} data-slot="dialog-close" {...props} />
));
DialogClose.displayName = DialogPrimitive.Close.displayName;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    data-slot="dialog-overlay"
    className={cn(
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, style, onPointerDown, ...props }, ref) => {
  const contentRef = React.useRef<React.ElementRef<typeof DialogPrimitive.Content> | null>(null);
  const cleanupDragRef = React.useRef<(() => void) | null>(null);

  const setRefs = React.useCallback(
    (node: React.ElementRef<typeof DialogPrimitive.Content> | null) => {
      contentRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  React.useEffect(() => () => cleanupDragRef.current?.(), []);

  const startDrag: React.PointerEventHandler<React.ElementRef<typeof DialogPrimitive.Content>> = (event) => {
    onPointerDown?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (typeof window === "undefined" || !window.matchMedia("(min-width: 640px)").matches) return;

    const node = contentRef.current;
    if (!node) return;

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("button, input, textarea, select, a, [role='button'], [data-no-dialog-drag]")) return;

    const header = target.closest("[data-slot='dialog-header']");
    if (!header || !node.contains(header)) return;

    const rect = node.getBoundingClientRect();
    const grabX = event.clientX - rect.left;
    const grabY = event.clientY - rect.top;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const previousUserSelect = document.body.style.userSelect;

    cleanupDragRef.current?.();
    document.body.style.userSelect = "none";

    const move = (moveEvent: PointerEvent) => {
      if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 3) return;
      dragging = true;

      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      const left = Math.min(Math.max(margin, moveEvent.clientX - grabX), maxLeft);
      const top = Math.min(Math.max(margin, moveEvent.clientY - grabY), maxTop);

      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.right = "auto";
      node.style.bottom = "auto";
      node.style.transform = "none";
      node.style.translate = "0px 0px";
      node.style.setProperty("--tw-translate-x", "0px");
      node.style.setProperty("--tw-translate-y", "0px");
      moveEvent.preventDefault();
    };

    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.body.style.userSelect = previousUserSelect;
      cleanupDragRef.current = null;
    };

    cleanupDragRef.current = stop;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
  };

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={setRefs}
        data-slot="dialog-content"
        className={cn(
          "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-x-0 bottom-0 z-50 grid w-full max-h-[92dvh] gap-4 overflow-y-auto rounded-t-2xl border p-4 shadow-lg duration-200 data-[state=closed]:slide-out-to-bottom-2 data-[state=open]:slide-in-from-bottom-2 sm:top-[50%] sm:left-[50%] sm:right-auto sm:bottom-auto sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:p-6 sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
          className,
        )}
        style={style}
        onPointerDown={startDrag}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-md opacity-60 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4">
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:cursor-move sm:select-none sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    data-slot="dialog-title"
    className={cn("text-lg leading-none font-semibold", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    data-slot="dialog-description"
    className={cn("text-muted-foreground text-sm", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
