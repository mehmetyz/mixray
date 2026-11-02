import { DEMO_ORIGIN_LABELS, type DemoClip, type DemoOrigin } from "@/lib/demos";

type DemoBadgeProps = {
  origin: DemoOrigin;
};

type DemoCreditProps = {
  demo: DemoClip;
};

/** Says plainly whether a demo was made by a model or recorded from real musicians. */
export function DemoBadge({ origin }: DemoBadgeProps) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        origin === "real" ? "border-text-2 text-text" : "border-line-2 bg-inset text-text-2"
      }`}
    >
      {DEMO_ORIGIN_LABELS[origin]}
    </span>
  );
}

/** The on-screen credit every demo carries where it plays. */
export function DemoCredit({ demo }: DemoCreditProps) {
  return (
    <div className="mt-2 space-y-1">
      <DemoBadge origin={demo.origin} />
      <p className="text-[11px] leading-snug text-muted">
        {demo.credit}.{" "}
        {demo.sourceUrl !== undefined ? (
          <a
            href={demo.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-text"
          >
            {demo.license}
          </a>
        ) : (
          demo.license
        )}
        .
      </p>
    </div>
  );
}
