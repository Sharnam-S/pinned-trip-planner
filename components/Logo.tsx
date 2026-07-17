// The "Pinned." lockup: a soft-tipped map pin whose yellow head rhymes with
// the wordmark's period. The pin inherits currentColor so the same component
// works anywhere the brand appears.
export function Logo({
  markSize = 22,
  className,
}: {
  markSize?: number;
  className?: string;
}) {
  return (
    <span className={className}>
      <svg
        className="logo-mark"
        width={markSize}
        height={markSize}
        viewBox="0 0 64 64"
        aria-hidden="true"
      >
        <path
          d="M32 2C19.3 2 9 12.3 9 25c0 16.9 20.1 34.6 21 35.4a3 3 0 0 0 4 0C34.9 59.6 55 41.9 55 25 55 12.3 44.7 2 32 2z"
          fill="currentColor"
        />
        <circle cx="32" cy="25" r="10.5" fill="var(--yellow)" />
      </svg>
      <span>
        Pinned<span className="brand-dot">.</span>
      </span>
    </span>
  );
}
