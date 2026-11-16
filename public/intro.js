// The entrance, and the seal it leaves behind.
//
// Guilloche is the woven rosette linework engraved on banknotes and share certificates: a few
// sine-modulated circles, phase-shifted against each other until they interlace. It was made to be
// hard to copy and it is rarely seen on screens. Here it is drawn live: each band is a family of
// curves r(t) = R + A cos(n t + phase), one curve per phase, so the family weaves into a braid.
// The entrance draws three bands and a centre rose line by line, sets the wordmark in the middle,
// then flies through the centre of the rosette onto the court.
import { gsap } from 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/+esm';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

// one braided band: `curves` closed curves around radius R, each with n lobes of depth A
function band({ R, A, n, curves, twist = 0, steps = 720 }) {
  const g = el('g', { class: 'g-band' });
  for (let j = 0; j < curves; j++) {
    const phase = (j / curves) * Math.PI * 2;
    let d = '';
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      // a second, slower wave leans the lobes so neighbouring curves cross instead of nesting
      const r = R + A * Math.cos(n * t + phase) + twist * A * Math.sin((n / 2) * t - phase);
      d += `${i ? 'L' : 'M'}${(r * Math.cos(t)).toFixed(1)} ${(r * Math.sin(t)).toFixed(1)}`;
    }
    g.append(el('path', { d: `${d}Z`, pathLength: 1 }));
  }
  return g;
}

// a line of small capitals set round a circle, as on a coin or a banknote border
function ring(svg, id, radius, text, size) {
  const defs = svg.querySelector('defs') || svg.insertBefore(el('defs'), svg.firstChild);
  defs.append(el('path', { id, d: `M0 ${-radius}A${radius} ${radius} 0 1 1 -0.01 ${-radius}` }));
  const t = el('text', { class: 'g-micro', 'font-size': size });
  const tp = el('textPath', { href: `#${id}`, startOffset: '0' });
  const once = `${text} · `;
  tp.textContent = once.repeat(Math.max(1, Math.floor((2 * Math.PI * radius) / (once.length * size * 0.72))));
  t.append(tp);
  const g = el('g', { class: 'g-ring' });
  g.append(t);
  return g;
}

const BANDS = [
  { R: 430, A: 26, n: 36, curves: 6, twist: 0.5 },   // outer lace
  { R: 318, A: 62, n: 14, curves: 12, twist: 0.35 }, // the main braid
  { R: 176, A: 44, n: 9, curves: 10, twist: 0.6 },
  { R: 70, A: 40, n: 5, curves: 8, twist: 0 },       // centre rose
];

function rosette(svg, key, words) {
  svg.setAttribute('viewBox', '-500 -500 1000 1000');
  const bands = BANDS.map((b) => band(b));
  const micro = ring(svg, `g-ring-${key}`, 378, words, 11);
  svg.append(bands[0], micro, bands[1], bands[2], bands[3]);
  return { bands, micro };
}

// ---------- the entrance ----------
// host: an empty fixed element already covering the page. Resolves when the court is revealed.
export function playIntro(host, { words, serial, onReveal } = {}) {
  host.innerHTML = `
    <svg class="g-rosette" aria-hidden="true"></svg>
    <p class="g-kicker g-top"><span>Fantasy basketball</span><span>Priced daily</span></p>
    <h1 class="g-word" aria-label="Pivot">${[...'Pivot'].map((c) => `<span><i>${c}</i></span>`).join('')}</h1>
    <p class="g-tag"><span>Where the market is <em>wrong</em></span></p>
    <p class="g-kicker g-bottom"><span>${serial || ''}</span><span>Click to enter</span></p>`;
  const svg = host.querySelector('svg');
  const { bands, micro } = rosette(svg, 'intro', words || 'Where the market is wrong');
  const paths = bands.map((b) => [...b.querySelectorAll('path')]);
  const letters = host.querySelectorAll('.g-word i');

  return new Promise((resolve) => {
    let leaving = false;
    gsap.set(paths.flat(), { strokeDasharray: 1, strokeDashoffset: 1 });
    gsap.set(letters, { yPercent: 115 });
    gsap.set([micro, host.querySelectorAll('.g-kicker span'), host.querySelector('.g-tag span')], { opacity: 0 });
    const spins = bands.map((b, i) => gsap.to(b, { rotation: i % 2 ? -50 : 50, duration: 6, ease: 'none', svgOrigin: '0 0' }));

    const draw = gsap.timeline();
    // the bands engrave from the centre outward, each curve a beat behind the last
    [3, 2, 1, 0].forEach((b, order) => draw.to(paths[b], { strokeDashoffset: 0, duration: 1.15, ease: 'power2.inOut', stagger: 0.035 }, order * 0.16));
    draw.to(micro, { opacity: 1, duration: 0.6 }, 0.7)
      .to(letters, { yPercent: 0, duration: 0.9, ease: 'expo.out', stagger: 0.07 }, 0.45)
      .to(host.querySelector('.g-tag span'), { opacity: 1, duration: 0.6 }, 1.1)
      .to(host.querySelectorAll('.g-kicker span'), { opacity: 1, duration: 0.5, stagger: 0.08 }, 1.0)
      .add(leave, '+=0.75');

    // through the eye of the rosette and out onto the court
    function leave() {
      if (leaving) return;
      leaving = true;
      draw.kill();
      removeEventListener('keydown', leave); removeEventListener('wheel', leave); host.removeEventListener('pointerdown', leave);
      onReveal?.();
      gsap.timeline({ onComplete: () => { spins.forEach((s) => s.kill()); host.remove(); resolve(); } })
        .to(host.querySelectorAll('.g-kicker, .g-tag'), { opacity: 0, duration: 0.25 }, 0)
        .to(letters, { yPercent: -115, duration: 0.5, ease: 'power3.in', stagger: 0.03 }, 0)
        .to(svg, { scale: 7, rotation: 40, duration: 1.05, ease: 'power3.in' }, 0.05)
        .to(host, { backgroundColor: 'rgba(20, 14, 56, 0)', duration: 0.55, ease: 'power1.in' }, 0.45)
        .to(svg, { opacity: 0, duration: 0.35 }, 0.75);
    }
    addEventListener('keydown', leave);
    addEventListener('wheel', leave, { passive: true });
    host.addEventListener('pointerdown', leave);
  });
}
