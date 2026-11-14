// The front page's 3D court. A night-time arena that the camera flies through as you scroll:
// a wide establishing shot, then low over the key while the day's mispriced players rise out of
// the floor as columns, then straight down onto the court before the page continues.
// Three.js renders the scene; GSAP ScrollTrigger maps scroll to one progress value (0 to 1).
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/+esm';
import { gsap } from 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/+esm';
import { ScrollTrigger } from 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/ScrollTrigger/+esm';

gsap.registerPlugin(ScrollTrigger);

const COURT = { L: 28.65, W: 15.24 };
const HOOP_X = COURT.L / 2 - 1.575;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- the floor, painted on a canvas ----------
function courtTexture() {
  const S = 80; // pixels per metre
  const c = document.createElement('canvas');
  c.width = Math.round(COURT.L * S); c.height = Math.round(COURT.W * S);
  const g = c.getContext('2d');
  // stained maple: boards run the length of the court, each a slightly different tone
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const board = 0.11 * S;
  for (let y = 0; y < c.height; y += board) {
    let x = -rnd() * 3 * S;
    while (x < c.width) {
      const len = (1.8 + rnd() * 2.4) * S;
      const l = 15 + rnd() * 5;
      g.fillStyle = `hsl(${22 + rnd() * 6} 46% ${l}%)`;
      g.fillRect(x, y, len, board - 1);
      g.globalAlpha = 0.18;
      for (let k = 0; k < 4; k++) {
        g.fillStyle = `hsl(20 40% ${l - 5}%)`;
        g.fillRect(x, y + rnd() * board, len, 1);
      }
      g.globalAlpha = 1;
      x += len + 1;
    }
  }
  const px = (m) => m * S;
  const cx = c.width / 2, cy = c.height / 2;
  const line = css('--text') || '#f3ece4';
  const paint = css('--accent') || '#ff7a1a';
  g.lineWidth = 0.05 * S;
  g.strokeStyle = line;
  // painted keys and the center circle
  for (const side of [-1, 1]) {
    const baseX = side > 0 ? c.width : 0;
    g.fillStyle = paint; g.globalAlpha = 0.55;
    g.fillRect(side > 0 ? baseX - px(5.8) : baseX, cy - px(2.45), px(5.8), px(4.9));
    g.globalAlpha = 1;
    g.strokeRect(side > 0 ? baseX - px(5.8) : baseX, cy - px(2.45), px(5.8), px(4.9));
    g.beginPath(); g.arc(baseX - side * px(5.8), cy, px(1.8), 0, Math.PI * 2); g.stroke();
    // three-point line: corners, then the arc around the hoop
    const hoop = baseX - side * px(1.575);
    const r = px(7.24), corner = px(6.7);
    const dx = Math.sqrt(r * r - corner * corner);
    g.beginPath();
    g.moveTo(baseX, cy - corner); g.lineTo(hoop - side * dx, cy - corner);
    const a = Math.atan2(corner, -side * dx);
    g.arc(hoop, cy, r, side > 0 ? -a : Math.PI - a, side > 0 ? a : Math.PI + a, side > 0);
    g.lineTo(baseX, cy + corner);
    g.stroke();
  }
  g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, c.height); g.stroke();
  g.beginPath(); g.arc(cx, cy, px(1.8), 0, Math.PI * 2); g.stroke();
  g.fillStyle = paint; g.globalAlpha = 0.9;
  g.beginPath(); g.arc(cx, cy, px(0.6), 0, Math.PI * 2); g.fill();
  g.globalAlpha = 1;
  g.strokeRect(1, 1, c.width - 2, c.height - 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---------- camera path: three key shots, eased between ----------
const SHOTS = [
  { pos: [-4, 15, 21], look: [2, 0, 0] },          // establishing: the whole floor under the lights
  { pos: [-1.5, 7.2, 13.5], look: [9.4, 1.4, 0.4] }, // over the arc, looking toward the hoop
  { pos: [0, 27, 9], look: [0, 0, 0.4] },          // high above centre court, the columns sinking away
];
const ease = (t) => t * t * (3 - 2 * t);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// On a tall, narrow screen the same framing needs the camera further back.
function shot(p, aspect) {
  const seg = p < 0.5 ? 0 : 1;
  const t = ease(Math.min(1, Math.max(0, (p - seg * 0.5) / 0.5)));
  const pos = mix(SHOTS[seg].pos, SHOTS[seg + 1].pos, t), look = mix(SHOTS[seg].look, SHOTS[seg + 1].look, t);
  const k = aspect < 1 ? Math.min(2.1, 1.25 / aspect) : 1;
  // and the subject sits lower in the frame, under the copy at the top
  const aim = aspect < 1 ? [look[0], look[1] + 2.2, look[2]] : look;
  return { pos: pos.map((v, i) => look[i] + (v - look[i]) * k), look: aim };
}

// players: [{ id, name, fpg, gap }] (gap = projection minus recent production)
export function mountStage({ canvas, labels, section, players, onPick, onPhase }) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = innerWidth < 760;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !small, powerPreference: 'high-performance' });
  } catch {
    section.classList.add('no-webgl');
    return () => {};
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.25 : 1.75));
  renderer.shadowMap.enabled = !small;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const bg = new THREE.Color(css('--bg') || '#100c09');
  const scene = new THREE.Scene();
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 22, 52);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);

  // floor and a dark apron around it
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(COURT.L, COURT.W), new THREE.MeshStandardMaterial({ map: courtTexture(), roughness: 0.42, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(80, 60), new THREE.MeshStandardMaterial({ color: 0x0d0907, roughness: 1 }));
  apron.rotation.x = -Math.PI / 2; apron.position.y = -0.01;
  apron.receiveShadow = true;
  scene.add(apron);

  // a hoop at each end: stanchion, glass board, orange rim
  const rimColor = new THREE.Color(css('--accent') || '#ff7a1a');
  for (const side of [-1, 1]) {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x1c1a19, roughness: 0.6, metalness: 0.4 });
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.25, 3.3, 0.25), steel);
    post.position.set(side * 1.2, 1.65, 0); g.add(post);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.16, 0.16), steel);
    arm.position.set(side * 0.65, 3.2, 0); g.add(arm);
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.07, 1.83), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, roughness: 0.05 }));
    board.position.set(0, 3.35, 0); g.add(board);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.018, 10, 40), new THREE.MeshStandardMaterial({ color: rimColor, roughness: 0.4, emissive: rimColor, emissiveIntensity: 0.25 }));
    rim.rotation.x = Math.PI / 2; rim.position.set(-side * 0.38, 3.05, 0); g.add(rim);
    g.position.x = side * (COURT.L / 2 - 1.2);
    g.traverse((m) => { m.castShadow = true; });
    scene.add(g);
  }

  // the ball, resting on the center circle
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 32, 16), new THREE.MeshStandardMaterial({ color: 0xc4561a, roughness: 0.75 }));
  ball.position.set(0, 0.12, 0); ball.castShadow = true;
  scene.add(ball);

  // arena lighting: a dim fill and two warm pools over the keys
  scene.add(new THREE.HemisphereLight(0x8a6a50, 0x0d0907, 0.55));
  const key = new THREE.SpotLight(0xffd7b0, 520, 60, 0.62, 0.55, 1.6);
  key.position.set(6, 17, 4); key.target.position.set(9, 0, 0);
  key.castShadow = !small; key.shadow.mapSize.set(1024, 1024);
  scene.add(key, key.target);
  const fill = new THREE.SpotLight(0xffc69a, 260, 60, 0.75, 0.7, 1.6);
  fill.position.set(-8, 16, -3); fill.target.position.set(-6, 0, 0);
  scene.add(fill, fill.target);

  // the day's mispriced players, standing along the three-point arc
  const n = players.length;
  const up = new THREE.Color(css('--up') || '#6cc4ae'), down = new THREE.Color(css('--down') || '#ff5f7a');
  const maxFp = Math.max(...players.map((p) => p.fpg), 1);
  const cols = players.map((p, i) => {
    const theta = (-62 + (124 * i) / Math.max(1, n - 1)) * (Math.PI / 180);
    const x = HOOP_X - 7.24 * Math.cos(theta), z = 7.24 * Math.sin(theta);
    const h = 0.5 + 3.1 * (p.fpg / maxFp);
    const color = p.gap >= 0 ? up : down;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.5), new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.1, emissive: color, emissiveIntensity: 0.12 }));
    mesh.position.set(x, 0, z); mesh.scale.y = 0.001; mesh.castShadow = true;
    scene.add(mesh);
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `col-label ${p.gap >= 0 ? 'up' : 'down'}`;
    el.innerHTML = `<b></b><span></span>`;
    el.querySelector('b').textContent = p.name;
    el.querySelector('span').textContent = `${p.fpg.toFixed(1)} proj · ${p.gap >= 0 ? '+' : '−'}${Math.abs(p.gap).toFixed(1)}`;
    el.onclick = () => onPick?.(p.id);
    labels.append(el);
    return { mesh, h, el };
  });

  // ---------- scroll drives one number; the render loop reads it ----------
  const state = { p: still ? 0.42 : 0 };
  let trigger = null;
  if (!still) {
    trigger = ScrollTrigger.create({
      trigger: section, start: 'top top', end: 'bottom bottom', scrub: 0.6,
      onUpdate: (self) => { state.p = self.progress; onPhase?.(self.progress); },
    });
  } else onPhase?.(state.p);

  const v = new THREE.Vector3();
  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w < 760 ? 52 : 40;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const t0 = performance.now();
  let raf = 0, visible = true;
  const frame = (now) => {
    raf = 0;
    if (!visible || document.hidden) return;
    const p = state.p;
    const s = shot(p, camera.aspect);
    // a slow drift so the establishing shot breathes; off when the user asks for less motion
    const drift = still ? 0 : Math.sin((now - t0) / 4000) * 0.35 * (1 - Math.min(1, p * 2));
    camera.position.set(s.pos[0] + drift, s.pos[1], s.pos[2]);
    camera.lookAt(s.look[0], s.look[1], s.look[2]);
    const rise = Math.min(1, Math.max(0, (p - 0.2) / 0.3)) * (1 - Math.min(1, Math.max(0, (p - 0.78) / 0.2)));
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const placed = [];
    const byDepth = cols.map((c, i) => [c, i]).sort((a, b) => a[0].mesh.position.distanceTo(camera.position) - b[0].mesh.position.distanceTo(camera.position));
    byDepth.forEach(([c, i]) => {
      const local = ease(Math.min(1, Math.max(0, rise * 1.35 - i * 0.03)));
      c.mesh.visible = local > 0.01;
      c.mesh.scale.y = Math.max(0.001, c.h * local);
      c.mesh.position.y = (c.h * local) / 2;
      v.set(c.mesh.position.x, c.h * local + 0.35, c.mesh.position.z).project(camera);
      const sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h;
      const clear = !placed.some(([px, py]) => Math.abs(px - sx) < 130 && Math.abs(py - sy) < 38);
      const on = local > 0.6 && v.z < 1 && clear;
      if (on) placed.push([sx, sy]);
      c.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      c.el.style.opacity = on ? Math.min(1, (local - 0.6) / 0.3) : 0;
      c.el.tabIndex = on ? 0 : -1;
    });
    ball.rotation.y = still ? 0 : (now - t0) / 5000;
    renderer.render(scene, camera);
    if (!still) raf = requestAnimationFrame(frame);
  };
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) raf = requestAnimationFrame(frame);
  });
  io.observe(section);
  raf = requestAnimationFrame(frame);
  if (still) requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    trigger?.kill();
    io.disconnect(); ro.disconnect();
    labels.textContent = '';
    renderer.dispose();
    scene.traverse((o) => { o.geometry?.dispose(); if (o.material) { o.material.map?.dispose(); o.material.dispose(); } });
  };
}
