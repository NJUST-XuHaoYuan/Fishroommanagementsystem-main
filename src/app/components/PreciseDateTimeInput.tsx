import { Input } from "./ui/input";
import { normalizeBioRecordTime } from "../utils/localDateTime";

type PreciseDateTimeInputProps = {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
};

function timePart(value?: string): string {
  return normalizeBioRecordTime(value).slice(11, 19);
}

function datePart(value?: string): string {
  return normalizeBioRecordTime(value).slice(0, 10);
}

function normalizeTime(value: string): string {
  if (!value) return "";
  return value.length === 5 ? `${value}:00` : value.slice(0, 8);
}

export function PreciseDateTimeInput({
  value,
  onChange,
  min,
  max,
  disabled,
  className,
}: PreciseDateTimeInputProps) {
  const date = datePart(value);
  const time = timePart(value);
  const minDate = datePart(min);
  const maxDate = datePart(max);
  const minTime = date && date === minDate ? timePart(min) : undefined;
  const maxTime = date && date === maxDate ? timePart(max) : undefined;

  const updateDate = (nextDate: string) => {
    if (!nextDate) return onChange("");
    onChange(`${nextDate}T${time || "00:00:00"}`);
  };

  const updateTime = (nextTime: string) => {
    if (!date) return;
    onChange(`${date}T${normalizeTime(nextTime) || "00:00:00"}`);
  };

  return (
    <div className={`grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(7.75rem,0.72fr)] gap-2 ${className ?? ""}`}>
      <Input
        type="date"
        aria-label="日期"
        min={minDate || undefined}
        max={maxDate || undefined}
        value={date}
        disabled={disabled}
        onChange={(event) => updateDate(event.target.value)}
        className="min-w-0 tabular-nums"
      />
      <Input
        type="time"
        aria-label="时分秒"
        step={1}
        min={minTime}
        max={maxTime}
        value={time}
        disabled={disabled || !date}
        onChange={(event) => updateTime(event.target.value)}
        className="min-w-0 tabular-nums"
      />
    </div>
  );
}
