import type { SVGProps, HTMLAttributes } from "react";

export type MixrayLogoProps = HTMLAttributes<HTMLSpanElement> & {
  size?: "sm" | "md" | "lg";
  showText?: boolean;
};

export type MixrayIconProps = SVGProps<SVGSVGElement> & {
  size?: number;
  variant?: "accent" | "monochrome";
};

/**
 * Mixray Tri-Stem Horizon icon mark.
 *
 * An aerodynamic play symbol (▶) formed by 3 horizontal frequency stems:
 * - Top stem: Treble frequencies (off-white #EAECEF)
 * - Mid stem: The isolated sound voice extending forward in surgical orange (#FF6A1A)
 * - Bottom stem: Bass frequencies (off-white #EAECEF)
 */
export function MixrayIcon({
  size = 24,
  variant = "accent",
  className = "",
  ...props
}: MixrayIconProps) {
  const midColor = variant === "accent" ? "#FF6A1A" : "currentColor";
  const baseColor = variant === "accent" ? "#EAECEF" : "currentColor";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {/* Top Stem: Treble Layer */}
      <path
        d="M 6.5 6.0 C 6.5 4.8, 7.8 4.2, 8.8 4.8 L 19.0 10.6 C 20.0 11.2, 19.6 12.5, 18.2 12.5 L 8.0 12.5 C 7.2 12.5, 6.5 11.8, 6.5 11.0 Z"
        fill={baseColor}
      />
      {/* Mid Stem: Isolated Voice extending to Play apex */}
      <path
        d="M 6.5 14.2 C 6.5 13.5, 7.3 13.0, 8.0 13.0 L 25.5 15.0 C 26.8 15.2, 26.8 16.8, 25.5 17.0 L 8.0 19.0 C 7.3 19.0, 6.5 18.5, 6.5 17.8 Z"
        fill={midColor}
      />
      {/* Bottom Stem: Bass Layer */}
      <path
        d="M 6.5 26.0 C 6.5 27.2, 7.8 27.8, 8.8 27.2 L 19.0 21.4 C 20.0 20.8, 19.6 19.5, 18.2 19.5 L 8.0 19.5 C 7.2 19.5, 6.5 20.2, 6.5 21.0 Z"
        fill={baseColor}
      />
    </svg>
  );
}

/**
 * Mixray header brand logo mark: Tri-Stem Horizon icon + clean lowercase wordmark.
 */
export function MixrayLogo({
  size = "md",
  showText = true,
  className = "",
  ...props
}: MixrayLogoProps) {
  const config = {
    sm: { icon: 20, text: "text-[16px]", gap: "gap-2" },
    md: { icon: 24, text: "text-[18px]", gap: "gap-2.5" },
    lg: { icon: 28, text: "text-[22px]", gap: "gap-3" },
  }[size];

  return (
    <span
      className={`inline-flex items-center ${config.gap} select-none ${className}`}
      aria-label="mixray"
      {...props}
    >
      <MixrayIcon size={config.icon} className="shrink-0" />
      {showText ? (
        <span
          className={`font-bold lowercase tracking-tight text-text ${config.text}`}
        >
          mixray
        </span>
      ) : null}
    </span>
  );
}
