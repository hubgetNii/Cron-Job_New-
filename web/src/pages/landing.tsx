import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { BlackHoleHeroSection } from '@/components/ui/blackhole-hero-section';

/** True while the viewport is narrow — drives the layout swap. */
function useNarrow(query = '(max-width: 767px)') {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const sync = () => setNarrow(m.matches);
    sync();
    m.addEventListener('change', sync);
    return () => m.removeEventListener('change', sync);
  }, [query]);
  return narrow;
}

export function LandingPage() {
  const narrow = useNarrow();

  return (
    <section className="relative min-h-[100svh] w-full">
      <BlackHoleHeroSection
        focus={narrow ? [0.5, 0.76] : [0.72, 0.46]}
        scrim={narrow ? 'top' : 'left'}
        scrimStrength={0.92}
        distance={24}
        elevation={narrow ? -7 : -5.5}
        fov={narrow ? 58 : 42}
        glow={narrow ? 0.85 : 1}
        steps={narrow ? 200 : 300}
        resolution={narrow ? 0.6 : 0.7}
      >
        <div className="flex h-full min-h-[100svh] items-start px-6 pt-16 sm:px-10 md:items-center md:pt-0 lg:px-20">
          <div className="max-w-[36rem]">
            <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-xs text-white/70">
              <ShieldCheck className="size-3.5" />
              Cron-driven health monitoring for payment rails
            </p>
            <h1 className="text-[2.5rem] font-light leading-[1.05] tracking-[-0.03em] text-white sm:text-6xl lg:text-[4rem]">
              A check that
              <br />
              always ran.
            </h1>
            <p className="mt-6 max-w-md text-[0.95rem] leading-relaxed text-white/60 md:mt-7">
              Every critical iSmartPay endpoint, verified at the business level every minute —
              on a scheduler that proves it fired, and whose own silence sets off an alarm.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3 md:mt-10">
              <Link
                to="/app"
                className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-black transition hover:bg-white/90"
              >
                Open dashboard
                <ArrowRight className="size-4" />
              </Link>
              <a
                href="https://claude.ai/code"
                className="rounded-full border border-white/20 px-6 py-3 text-sm text-white/80 transition hover:border-white/40 hover:text-white"
              >
                Read the spec
              </a>
            </div>
          </div>
        </div>
      </BlackHoleHeroSection>
    </section>
  );
}
