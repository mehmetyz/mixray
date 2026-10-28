"use client";

import { useMemo } from "react";
import { parseRecipeSummary, type RecipeRow } from "@/lib/studio/format";
import type { Recipe } from "@/lib/trackmap/trackmap.generated";

type RecipeCardProps = {
  recipe: Recipe | undefined;
  compact?: boolean;
};

type BlockProps = {
  title: string;
  rows: RecipeRow[];
};

function ParameterBlock({ title, rows }: BlockProps) {
  return (
    <div className="space-y-1.5 rounded-well border border-line bg-inset p-2.5">
      <p className="mono-num text-[10px] font-semibold uppercase tracking-wider text-muted">
        {title}
      </p>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-2 text-xs">
            <span className="capitalize text-muted">{row.label}</span>
            <span className="mono-num truncate font-medium text-text">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RecipeCard({ recipe, compact = false }: RecipeCardProps) {
  const parsed = useMemo(() => parseRecipeSummary(recipe), [recipe]);
  const { envelope } = parsed;

  const attackHeight = Math.max(18, Math.min(95, Math.round((envelope.attackMs / 120) * 80) + 18));
  const decayHeight = Math.max(24, Math.min(95, Math.round((envelope.decayMs / 800) * 85)));
  const sustainHeight = Math.max(20, Math.min(95, Math.round(envelope.sustain * 90)));
  const releaseHeight = Math.max(22, Math.min(95, Math.round((envelope.releaseMs / 800) * 85)));

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Sound recipe</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <ParameterBlock title="Oscillators" rows={parsed.oscillatorRows} />
        <ParameterBlock title="Filter" rows={parsed.filterRows} />
        {!compact ? <ParameterBlock title="FX" rows={parsed.fxRows} /> : null}
        {!compact ? <ParameterBlock title="Play" rows={parsed.playRows} /> : null}
      </div>

      <div className="space-y-1.5 rounded-well border border-line bg-inset p-2.5">
        <div className="flex items-center justify-between text-[10px]">
          <span className="mono-num uppercase tracking-wider text-muted">Envelope</span>
          <span className="mono-num text-muted">ADSR</span>
        </div>
        <div
          role="img"
          aria-label={`Amp envelope: attack ${envelope.attackMs}ms, decay ${envelope.decayMs}ms, sustain ${Math.round(envelope.sustain * 100)}%, release ${envelope.releaseMs}ms`}
          className="grid h-10 grid-cols-4 items-end gap-2 pt-1"
        >
          <div className="flex h-full flex-col items-center justify-end gap-1">
            <div style={{ height: `${attackHeight}%` }} className="w-full rounded-xs bg-accent" />
            <span className="mono-num text-[10px] text-text-2">{Math.round(envelope.attackMs)}ms</span>
          </div>
          <div className="flex h-full flex-col items-center justify-end gap-1">
            <div style={{ height: `${decayHeight}%` }} className="w-full rounded-xs bg-inactive" />
            <span className="mono-num text-[10px] text-muted">{Math.round(envelope.decayMs)}ms</span>
          </div>
          <div className="flex h-full flex-col items-center justify-end gap-1">
            <div style={{ height: `${sustainHeight}%` }} className="w-full rounded-xs bg-inactive" />
            <span className="mono-num text-[10px] text-muted">{envelope.sustain.toFixed(2)}</span>
          </div>
          <div className="flex h-full flex-col items-center justify-end gap-1">
            <div style={{ height: `${releaseHeight}%` }} className="w-full rounded-xs bg-inactive" />
            <span className="mono-num text-[10px] text-muted">{Math.round(envelope.releaseMs)}ms</span>
          </div>
        </div>
      </div>
    </div>
  );
}

