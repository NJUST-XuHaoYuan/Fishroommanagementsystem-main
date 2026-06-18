type LogoLoaderProps = {
  label?: string;
};

export function LogoLoader({ label = "正在加载…" }: LogoLoaderProps) {
  return (
    <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
      <div className="logo-loader" aria-hidden="true">
        <svg viewBox="0 0 160 160" className="logo-loader__svg">
          <defs>
            <linearGradient id="logo-loader-wash" x1="20" y1="130" x2="142" y2="24" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="oklch(0.46 0.07 223)" />
              <stop offset="0.55" stopColor="oklch(0.33 0.045 260)" />
              <stop offset="1" stopColor="oklch(0.22 0.018 270)" />
            </linearGradient>
          </defs>
          <circle className="logo-loader__halo" cx="80" cy="80" r="68" />
          <g className="logo-loader__mark">
            <path
              className="logo-loader__shape logo-loader__shape--fish"
              d="M24 86c9-18 27-28 48-23 16 4 27 16 30 31-14 12-33 15-52 9-12-4-21-10-26-17Z"
            />
            <path
              className="logo-loader__shape logo-loader__shape--fish"
              d="M101 91c11-12 22-17 34-15-6 9-6 18 0 28-12 2-23-3-34-13Z"
            />
            <path
              className="logo-loader__shape logo-loader__shape--fish"
              d="M44 78c10-3 20-1 31 6"
            />
            <path
              className="logo-loader__shape logo-loader__shape--fish"
              d="M45 98c11-1 21-5 30-13"
            />
            <circle className="logo-loader__eye" cx="44" cy="86" r="3.8" />
            <path
              className="logo-loader__shape logo-loader__shape--coral"
              d="M97 70c-1-18 4-34 14-48"
            />
            <path
              className="logo-loader__shape logo-loader__shape--coral"
              d="M108 34c-10-3-18-9-23-18"
            />
            <path
              className="logo-loader__shape logo-loader__shape--coral"
              d="M104 45c12-5 20-14 23-27"
            />
            <path
              className="logo-loader__shape logo-loader__shape--coral"
              d="M101 56c-13-4-23-12-31-24"
            />
            <path
              className="logo-loader__shape logo-loader__shape--coral"
              d="M102 59c13 1 24-4 33-15"
            />
            <path
              className="logo-loader__shape logo-loader__shape--coral"
              d="M96 69c-16 1-29-5-38-19"
            />
            <path
              className="logo-loader__shape logo-loader__shape--coral"
              d="M98 69c13 7 24 7 36 0"
            />
          </g>
        </svg>
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
