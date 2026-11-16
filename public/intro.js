// The entrance: a flower that blooms in ASCII.
//
// The screen is a grid of monospace cells. Each frame, every cell asks how far inside the flower
// it is: three rings of petals (rose curves turned against each other), a seeded centre, and a
// soft falloff at each petal's edge, with a vein down its middle. That depth picks a character from
// light to dense ( .:-=+*#%@ ), so the flower is drawn in type. A blurred copy of the same canvas
// sits behind it as a glow. The petals open ring by ring around the wordmark, then the view falls
// into the centre of the flower and out onto the court.
import { gsap } from 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/+esm';

const RAMP = ' .:-=+*#%@';
// three rings of petals, outermost first: count, length (share of the radius), width, turn
const RINGS = [
  { n: 8, len: 1, width: 0.86, turn: 0, open: [0.2, 1.35] },
  { n: 8, len: 0.7, width: 0.84, turn: Math.PI / 8, open: [0.1, 1.15] },
  { n: 6, len: 0.42, width: 0.9, turn: 0.2, open: [0, 0.95] },
];
const INK = ['#7d68e8', '#a996ff', '#d9cfff', '#f6e7c8']; // outer ring to centre, then the heart, on deep purple

function flower(canvas, glow) {
  const ctx = canvas.getContext('2d'), gctx = glow.getContext('2d');
  let W = 0, H = 0, cw = 0, ch = 0, cols = 0, rows = 0, dpr = 1;
  const size = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    for (const c of [canvas, glow]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = `${W}px`; c.style.height = `${H}px`; }
    cw = W < 700 ? 8 : 10; ch = cw * 1.7;
    cols = Math.ceil(W / cw); rows = Math.ceil(H / ch);
  };
  size();
  addEventListener('resize', size);
  const state = { bloom: 0, spin: 0, zoom: 1, fade: 1 };

  // how far inside the flower a point is (0 outside, about 1 at the heart), and which ring it is in
  const field = (x, y, R, t) => {
    const r = Math.hypot(x, y) / R, a = Math.atan2(y, x);
    let best = 0, ring = -1;
    RINGS.forEach((g, i) => {
      const open = Math.max(0, Math.min(1, (state.bloom - g.open[0]) / (g.open[1] - g.open[0])));
      if (!open) return;
      const ease = 1 - (1 - open) ** 3;
      const len = g.len * ease;
      // angle to the nearest petal's axis, as a fraction of the gap between petals
      const step = (Math.PI * 2) / g.n, phase = a - g.turn - state.spin * (i % 2 ? -1 : 1) * (1 + i * 0.4);
      const d = Math.abs(((phase % step) + step * 1.5) % step - step / 2) / (step / 2);
      // a rounded petal: widest about two thirds out, closing to a blunt tip
      const along = r / Math.max(1e-3, len);
      if (along > 1) return;
      const profile = Math.sqrt(Math.max(0, Math.sin(along * Math.PI * 0.82))) * (1 - along ** 6 * 0.4) * g.width;
      const inside = 1 - d / Math.max(1e-3, profile);
      if (inside <= 0) return;
      // dense down the vein and toward the base, thinning to light characters at the edges
      const vein = Math.exp(-((d / Math.max(1e-3, profile)) ** 2) * 30) * 0.3;
      const v = Math.min(1, inside ** 1.1 * (0.5 + 0.5 * (1 - along)) + vein + 0.04 * Math.sin(t * 2.5 + r * 11 + i));
      // inner rings lie on top of the outer ones, as real petals do
      if (v > 0.06 && i >= ring) { best = v; ring = i; }
    });
    // the seeded centre
    const heart = Math.max(0, 1 - r / (0.14 * Math.min(1, state.bloom * 2)));
    if (heart > 0) { const seeds = 0.5 + 0.5 * Math.sin(a * 13 + r * 40); best = Math.min(1, heart * 0.7 + seeds * 0.4); ring = 3; }
    return [best, ring];
  };

  const draw = (t) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `600 ${cw * 1.15}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const R = Math.min(W, H) * 0.46 * state.zoom, cx = W / 2, cy = H / 2;
    for (let ring = 0; ring < 4; ring++) {
      ctx.fillStyle = INK[ring];
      ctx.globalAlpha = state.fade;
      for (let j = 0; j < rows; j++) {
        const y = j * ch + ch / 2 - cy;
        if (Math.abs(y) > R * 1.05) continue;
        for (let i = 0; i < cols; i++) {
          const x = i * cw + cw / 2 - cx;
          if (Math.abs(x) > R * 1.05) continue;
          const [v, r] = field(x, y, R, t);
          if (r !== ring || v < 0.06) continue;
          ctx.fillText(RAMP[Math.min(RAMP.length - 1, Math.round(v * (RAMP.length - 1)))], cx + x, cy + y);
        }
      }
    }
    // the glow is the same drawing, smaller and blurred (CSS does the blur)
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.clearRect(0, 0, glow.width, glow.height);
    gctx.drawImage(canvas, 0, 0, glow.width, glow.height);
  };
  let raf = 0;
  const t0 = performance.now();
  const loop = (now) => { draw((now - t0) / 1000); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  return { state, stop: () => { cancelAnimationFrame(raf); removeEventListener('resize', size); } };
}

// host: an empty fixed element covering the page. Resolves when the court is revealed.
export function playIntro(host, { serial, onReveal } = {}) {
  host.innerHTML = `
    <canvas class="g-glow" aria-hidden="true"></canvas>
    <canvas class="g-ascii" aria-hidden="true"></canvas>
    <p class="g-kicker g-top"><span>Fantasy basketball</span><span>Priced daily</span></p>
    <h1 class="g-word" aria-label="Pivot">${[...'Pivot'].map((c) => `<span><i>${c}</i></span>`).join('')}</h1>
    <p class="g-tag"><span>Where the market is <em>wrong</em></span></p>
    <p class="g-kicker g-bottom"><span>${serial || ''}</span><span>Click to enter</span></p>`;
  const art = flower(host.querySelector('.g-ascii'), host.querySelector('.g-glow'));
  const letters = host.querySelectorAll('.g-word i');

  return new Promise((resolve) => {
    let leaving = false;
    gsap.set(letters, { yPercent: 115 });
    gsap.set([host.querySelectorAll('.g-kicker span'), host.querySelector('.g-tag span')], { opacity: 0 });
    const spin = gsap.to(art.state, { spin: 0.6, duration: 8, ease: 'none' });
    const show = gsap.timeline()
      .to(art.state, { bloom: 1.4, duration: 2.4, ease: 'power2.out' }, 0)
      .to(letters, { yPercent: 0, duration: 0.9, ease: 'expo.out', stagger: 0.07 }, 0.9)
      .to(host.querySelector('.g-tag span'), { opacity: 1, duration: 0.6 }, 1.5)
      .to(host.querySelectorAll('.g-kicker span'), { opacity: 1, duration: 0.5, stagger: 0.08 }, 1.3)
      .add(leave, '+=0.7');

    // into the heart of the flower and out onto the court
    function leave() {
      if (leaving) return;
      leaving = true;
      show.kill();
      removeEventListener('keydown', leave); removeEventListener('wheel', leave); host.removeEventListener('pointerdown', leave);
      onReveal?.();
      gsap.timeline({ onComplete: () => { spin.kill(); art.stop(); host.remove(); resolve(); } })
        .to(host.querySelectorAll('.g-kicker, .g-tag'), { opacity: 0, duration: 0.25 }, 0)
        .to(letters, { yPercent: -115, duration: 0.5, ease: 'power3.in', stagger: 0.03 }, 0)
        .to(art.state, { zoom: 6, spin: '+=0.5', duration: 1.05, ease: 'power3.in' }, 0.05)
        .to(art.state, { fade: 0, duration: 0.4 }, 0.7)
        .to(host, { backgroundColor: 'rgba(20, 14, 56, 0)', duration: 0.55, ease: 'power1.in' }, 0.45);
    }
    addEventListener('keydown', leave);
    addEventListener('wheel', leave, { passive: true });
    host.addEventListener('pointerdown', leave);
  });
}
