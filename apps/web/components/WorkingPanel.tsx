const BAR_LEVELS = [
  0.3, 0.55, 0.8, 0.45, 0.95, 0.6, 0.35, 0.7, 1, 0.5, 0.3, 0.65, 0.9, 0.4, 0.75, 0.55, 0.3, 0.85, 0.6,
  0.4, 0.95, 0.7, 0.35, 0.5, 0.8, 0.45, 0.65, 0.3,
];

type WorkingPanelProps = {
  steps: readonly string[];
  current: number;
  seconds: number;
  /** What is being worked on: the file, or the sound being separated. */
  subject?: string;
  note?: string;
};

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Real steps and real time only: the steps differ hugely in length, so a percentage would be a guess. */
export function WorkingPanel({ steps, current, seconds, subject, note }: WorkingPanelProps) {
  return (
    <div role="status" aria-live="polite" className="rounded-card border border-line bg-surface p-5">
      <div aria-hidden="true" className="flex h-14 items-center justify-between">
        {BAR_LEVELS.map((level, index) => (
          <span
            key={index}
            style={{ height: `${level * 100}%`, animationDelay: `${index * -70}ms` }}
            className="working-bar w-1 rounded-full bg-accent"
          />
        ))}
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-lg font-semibold tracking-tight text-text">
          {steps[current] ?? "Working"}
        </p>
        <span className="mono-num shrink-0 text-sm text-text-2">{formatElapsed(seconds)}</span>
      </div>
      {subject !== undefined ? <p className="mt-0.5 truncate text-sm text-muted">{subject}</p> : null}

      {steps.length > 1 ? (
        <ol className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
          {steps.map((step, index) => (
            <li key={step} className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  index < current ? "bg-text-2" : index === current ? "bg-accent" : "bg-line-2"
                }`}
              />
              <span
                aria-current={index === current ? "step" : undefined}
                className={
                  index === current
                    ? "font-medium text-text"
                    : index < current
                      ? "text-text-2"
                      : "text-muted"
                }
              >
                {step}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      {note !== undefined ? <p className="mt-4 text-xs text-muted">{note}</p> : null}
    </div>
  );
}
