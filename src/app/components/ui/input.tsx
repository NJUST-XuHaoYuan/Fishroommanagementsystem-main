import * as React from "react";

import { cn } from "./utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, onClick, ...props }, ref) => {
    const shouldOpenPicker = type === "date" || type === "datetime-local";

    const handleClick = (event: React.MouseEvent<HTMLInputElement>) => {
      onClick?.(event);
      if (event.defaultPrevented || !shouldOpenPicker) return;

      const input = event.currentTarget as HTMLInputElement & { showPicker?: () => void };
      if (input.disabled || input.readOnly) return;

      try {
        input.showPicker?.();
      } catch {
        // Browsers without showPicker support keep the native click behavior.
      }
    };

    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        onClick={handleClick}
        className={cn(
          "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input flex h-9 w-full min-w-0 rounded-md border px-3 py-1 text-base bg-input-background transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
          className,
        )}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

export { Input };
