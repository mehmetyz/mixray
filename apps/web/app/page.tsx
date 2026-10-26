import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { stepEyebrow } from "@/lib/steps";
import { DEMO_CLIP_IDS } from "@/lib/trackmap/load";

export default function AddPage() {
  return (
    <>
      <AppHeader nav={{ current: "add" }} />
      <main className="page-container flex flex-col gap-6 py-10">
        <p className="eyebrow">{stepEyebrow("add")}</p>
        <h1 className="max-w-3xl text-5xl leading-[1.02] font-extrabold tracking-[-2px] md:text-[64px]">
          Point at a sound. Learn to play it.
        </h1>
        <p className="max-w-2xl text-lg text-text-2">
          Add a song or a video you own, pick the sound you love, and learn it on your keyboard.
        </p>
        <ul className="flex flex-wrap gap-3">
          {DEMO_CLIP_IDS.map((id) => (
            <li key={id}>
              <Link
                href={`/c/${id}/pick`}
                className="inline-flex min-h-12 items-center rounded-full bg-accent px-6 font-semibold text-accent-ink hover:bg-accent-hover"
              >
                Try the demo →
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
