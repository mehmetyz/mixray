import type { Metadata } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono, Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-manrope",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "600"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Mixray",
  description: "Point at a sound. Hear it alone. Learn to play it.",
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" className={`${manrope.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-dvh bg-bg font-sans text-text antialiased">{children}</body>
    </html>
  );
}
