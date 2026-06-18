type LogoLoaderProps = {
  label?: string;
};

export function LogoLoader({ label = "正在加载…" }: LogoLoaderProps) {
  return (
    <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
      <div className="logo-loader" aria-hidden="true">
        <img className="logo-loader__asset" src="/assets/marine-forest-logo-loader.svg" alt="" />
      </div>
      <div className="text-center">
        <div className="text-sm font-medium text-slate-900">{label}</div>
        <div className="mt-2 flex items-center justify-center gap-1.5" aria-hidden="true">
          <span className="logo-loader__dot" />
          <span className="logo-loader__dot logo-loader__dot--delay-1" />
          <span className="logo-loader__dot logo-loader__dot--delay-2" />
        </div>
      </div>
    </div>
  );
}
