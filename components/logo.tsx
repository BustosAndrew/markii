export function Logo({
  size = 32,
  awake = false,
}: {
  size?: number;
  awake?: boolean;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <linearGradient id="markii-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#590D22" />
          <stop offset="0.2" stopColor="#800F2F" />
          <stop offset="0.4" stopColor="#A4133C" />
          <stop offset="0.6" stopColor="#C9184A" />
          <stop offset="0.8" stopColor="#FF4D6D" />
          <stop offset="1" stopColor="#FF758F" />
        </linearGradient>
      </defs>
      <path
        d="M186 168 v-4 a70 70 0 0 1 140 0 v4"
        fill="none"
        stroke="url(#markii-g)"
        strokeWidth="36"
        strokeLinecap="round"
      />
      <path
        d="M166 150 L346 150 Q390 150 395 194 L419 370 Q428 430 366 430 L146 430 Q84 430 93 370 L117 194 Q122 150 166 150 Z"
        fill="url(#markii-g)"
      />
      <rect x="152" y="232" width="208" height="156" rx="44" fill="#FAFAFA" />
      <rect x="196" y="278" width="120" height="58" rx="29" fill="url(#markii-g)" />
      <circle
        cx="228"
        cy="307"
        r="12"
        fill="#FAFAFA"
        className={awake ? "logo-eye" : undefined}
      />
      <circle
        cx="284"
        cy="307"
        r="12"
        fill="#FAFAFA"
        className={awake ? "logo-eye" : undefined}
      />
    </svg>
  );
}
