import { cookies } from "next/headers";
import { AccessForm } from "@/components/landing/AccessForm";
import { LandingHero } from "@/components/landing/LandingHero";
import { MixrayLogo } from "@/components/MixrayLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ACCESS_COOKIE, ACCESS_KEY_PARAM, hasAccess, safeNextPath } from "@/lib/access";
import { demoVideoSource } from "@/lib/landing/demo-video";

type LandingPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const STEPS: readonly { name: string; text: string }[] = [
  { name: "Add", text: "A song or a video of up to 30 seconds, or one of six demos." },
  { name: "Isolate", text: "Type the sound, take a suggestion, or draw over the instrument in the video." },
  { name: "Analyze", text: "See tempo, key, chords and notes. Readings are automatic and can be wrong." },
  { name: "Practice", text: "Play on a MIDI keyboard or your computer keys. Each bar is scored, and the Coach can set the loop, tempo or hand." },
  { name: "Export", text: "Take the audio, the MIDI parts and a suggested synth patch to your own tools." },
];

const MODELS: readonly { name: string; text: string }[] = [
  { name: "SAM Audio", text: "Separates the sound you asked for." },
  { name: "SAM 3.1", text: "Outlines the instrument as it moves through the video." },
  { name: "Muse Spark", text: "Names what you drew, suggests sounds and coaches your take." },
  { name: "Muse Spark Open", text: "Suggests a starting synth patch." },
  { name: "Muse Voice Transcribe", text: "Hears your commands while both hands are on the keys." },
  { name: "Demucs, Basic Pitch", text: "Open-source support: standard stems, and audio to notes." },
];

export default async function LandingPage({ searchParams }: LandingPageProps) {
  const params = await searchParams;
  const { next } = params;
  const cookieStore = await cookies();
  const entered = await hasAccess(cookieStore.get(ACCESS_COOKIE)?.value);
  const video = demoVideoSource(process.env.MIXRAY_DEMO_VIDEO_URL);

  return (
    <div className="mx-auto min-h-dvh max-w-[90rem] px-4 sm:px-8">
      <header className="flex h-16 items-center justify-between">
        <MixrayLogo size="md" />
        <ThemeToggle />
      </header>

      <main className="pb-16 pt-4 lg:pt-8">
        <LandingHero>
          <AccessForm
            hasAccess={entered}
            next={safeNextPath(typeof next === "string" ? next : undefined)}
            linkFailed={params[ACCESS_KEY_PARAM] !== undefined}
          />
        </LandingHero>

        {video !== null ? (
          <section aria-labelledby="demo-video" className="mt-20 border-t border-line pt-8">
            <h2 id="demo-video" className="text-2xl font-semibold tracking-tight text-text">
              See it from start to finish
            </h2>
            <div className="mt-6 aspect-video max-w-5xl overflow-hidden rounded-card border border-line bg-inset">
              {video.kind === "embed" ? (
                <iframe
                  src={video.url}
                  title="Mixray demo video"
                  allowFullScreen
                  loading="lazy"
                  className="h-full w-full"
                />
              ) : (
                <video src={video.url} controls preload="metadata" className="h-full w-full" />
              )}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="how-it-works" className="mt-20 border-t border-line pt-8">
          <h2 id="how-it-works" className="text-2xl font-semibold tracking-tight text-text">
            From a clip to your hands
          </h2>
          <ol className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((step, index) => (
              <li key={step.name}>
                <span className="mono-num text-sm text-muted">{index + 1}</span>
                <h3 className="mt-1 text-base font-semibold text-text">{step.name}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-text-2">{step.text}</p>
              </li>
            ))}
          </ol>
          <p className="mt-8 max-w-2xl text-sm leading-relaxed text-text-2">
            Notes are read for vocals, bass, guitar and piano. Other sounds can be heard alone and exported, without notes.
          </p>
        </section>

        <section aria-labelledby="models" className="mt-20 border-t border-line pt-8">
          <h2 id="models" className="text-2xl font-semibold tracking-tight text-text">
            What does the work
          </h2>
          <dl className="mt-6 max-w-3xl divide-y divide-line border-y border-line">
            {MODELS.map((model) => (
              <div key={model.name} className="grid gap-1 py-3 sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-4">
                <dt className="text-sm font-medium text-text">{model.name}</dt>
                <dd className="text-sm text-text-2">{model.text}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>

      <footer className="flex flex-wrap justify-between gap-2 border-t border-line py-6 text-xs text-text-2">
        <span>Built for the Meta Global AI Developer Hackathon by Mehmet Yildiz</span>
        <span>Built with Muse Spark Open</span>
      </footer>
    </div>
  );
}
