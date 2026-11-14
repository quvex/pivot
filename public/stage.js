// The front page's etched court. The scene is lit and rendered in greys, then a post-process
// shader redraws it as an engraving: purple ink on cream paper, with cross-hatching that gets
// denser in shadow and outlines found from the depth buffer.
// Two teams take the floor: the most underpriced player at each position on the right, the most
// overpriced on the left, each built to his real height and wearing his number, on a ring sized
// by his projection. Scrolling walks the camera from the whole court to the underpriced half and
// round the far end to the overpriced half (GSAP ScrollTrigger); dragging turns the view on top of
// that, and clicking a player picks him out.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/+esm';
import { gsap } from 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/+esm';
import { ScrollTrigger } from 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/ScrollTrigger/+esm';

gsap.registerPlugin(ScrollTrigger);

const COURT = { L: 28.65, W: 15.24 };
const HOOP_X = COURT.L / 2 - 1.575;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const grey = (v) => new THREE.Color(v, v, v);
const rgb = (hex) => new THREE.Vector3(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);

// ---------- the floor: a grey-scale court the shader turns into ink ----------
function courtTexture() {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = Math.round(COURT.L * S); c.height = Math.round(COURT.W * S);
  const g = c.getContext('2d');
  g.fillStyle = '#f2f2f2';
  g.fillRect(0, 0, c.width, c.height);
  // board seams, faint enough to read as engraved grain
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#d4d4d4';
  for (let y = 0; y < c.height; y += 0.11 * S) {
    g.fillRect(0, y, c.width, 1);
    for (let x = -rnd() * 3 * S; x < c.width; x += (1.8 + rnd() * 2.4) * S) g.fillRect(x, y, 1, 0.11 * S);
  }
  const px = (m) => m * S, cy = c.height / 2;
  g.lineWidth = 0.09 * S;
  g.strokeStyle = '#111';
  for (const side of [-1, 1]) {
    const base = side > 0 ? c.width : 0;
    g.fillStyle = '#8c8c8c';
    g.fillRect(side > 0 ? base - px(5.8) : base, cy - px(2.45), px(5.8), px(4.9));
    g.strokeRect(side > 0 ? base - px(5.8) : base, cy - px(2.45), px(5.8), px(4.9));
    g.beginPath(); g.arc(base - side * px(5.8), cy, px(1.8), 0, Math.PI * 2); g.stroke();
    const hoop = base - side * px(1.575), r = px(7.24), corner = px(6.7), dx = Math.sqrt(r * r - corner * corner);
    g.beginPath();
    g.moveTo(base, cy - corner); g.lineTo(hoop - side * dx, cy - corner);
    const a = Math.atan2(corner, -side * dx);
    g.arc(hoop, cy, r, side > 0 ? -a : Math.PI - a, side > 0 ? a : Math.PI + a, side > 0);
    g.lineTo(base, cy + corner);
    g.stroke();
  }
  g.beginPath(); g.moveTo(c.width / 2, 0); g.lineTo(c.width / 2, c.height); g.stroke();
  g.beginPath(); g.arc(c.width / 2, cy, px(1.8), 0, Math.PI * 2); g.stroke();
  g.strokeRect(2, 2, c.width - 4, c.height - 4);
  g.fillStyle = '#1a1a1a';
  g.font = `italic 400 ${Math.round(1.05 * S)}px "Bodoni Moda", "Didot", serif`;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'center';
  g.fillText('Overpriced', c.width * 0.25, 1.55 * S);
  g.fillText('Underpriced', c.width * 0.75, 1.55 * S);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  return tex;
}

// ---------- a player: capsules on a joint hierarchy, posed ----------
// Angles in radians. Limbs hang down -y; a negative x rotation swings a limb forward.
// Arm entries are [forward swing, outward swing] for [left, right].
const POSES = {
  jumpshot: { lift: 0.32, lean: -0.06, thigh: [-0.35, -0.15], knee: [0.7, 0.35], arm: [[-2.35, -0.25], [-2.75, 0.05]], elbow: [-0.85, -1.15], ball: 'shot' },
  dribble: { lift: -0.12, lean: 0.32, thigh: [-0.75, -0.45], knee: [1.15, 0.85], arm: [[-0.95, 0.5], [-0.55, 0.15]], elbow: [-0.7, -0.55], ball: 'dribble' },
  defend: { lift: -0.16, lean: 0.28, thigh: [-0.8, -0.8], knee: [1.2, 1.2], spread: 0.28, arm: [[-0.35, 1.25], [-0.35, 1.25]], elbow: [-0.35, -0.35] },
  post: { lift: 0, lean: 0.1, thigh: [-0.3, -0.25], knee: [0.45, 0.4], spread: 0.12, arm: [[-2.95, 0.15], [-2.95, 0.15]], elbow: [-0.25, -0.25] },
  set: { lift: 0, lean: 0.12, thigh: [-0.35, -0.3], knee: [0.55, 0.5], spread: 0.1, arm: [[-1.1, 0.25], [-1.1, 0.25]], elbow: [-1.3, -1.3] },
};

function numberDecal(num, ink = '#111') {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = ink;
  g.font = '400 96px "Bodoni Moda", "Didot", serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(num, 64, 70);
  return new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, alphaTest: 0.4, depthWrite: false });
}

function limb(len, r, mat) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 12), mat);
  m.position.y = -len / 2;
  g.add(m);
  return g;
}

function makePlayer(poseName, jersey, mats) {
  const P = POSES[poseName];
  const root = new THREE.Group();
  const pelvis = new THREE.Group();
  pelvis.position.y = 1.0 + P.lift;
  root.add(pelvis);
  const shorts = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.3, 14), mats.shorts);
  shorts.position.y = -0.08;
  pelvis.add(shorts);
  [-1, 1].forEach((side, i) => {
    const hip = limb(0.36, 0.08, mats.skin);
    hip.position.set(side * 0.1, -0.12, 0);
    hip.rotation.set(P.thigh[i], 0, side * (P.spread || 0.04));
    const knee = limb(0.36, 0.068, mats.skin);
    knee.position.y = -0.44;
    knee.rotation.x = P.knee[i];
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.09, 0.28), mats.shoe);
    shoe.position.set(0, -0.47, 0.06);
    shoe.rotation.x = -P.knee[i] - P.thigh[i];
    knee.add(shoe);
    hip.add(knee);
    pelvis.add(hip);
  });
  const spine = new THREE.Group();
  spine.rotation.x = P.lean;
  pelvis.add(spine);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.36, 4, 14), mats.jersey);
  torso.scale.set(1.28, 1, 0.78);
  torso.position.y = 0.3;
  spine.add(torso);
  if (jersey) {
    for (const z of [0.142, -0.142]) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), numberDecal(jersey, mats.ink));
      d.position.set(0, 0.34, z);
      if (z < 0) d.rotation.y = Math.PI;
      spine.add(d);
    }
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 18, 14), mats.skin);
  head.scale.set(0.92, 1.08, 1);
  head.position.y = 0.72;
  spine.add(head);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 8), mats.skin);
  neck.position.y = 0.6;
  spine.add(neck);
  const hands = [];
  [-1, 1].forEach((side, i) => {
    const sh = limb(0.25, 0.055, mats.skin);
    sh.position.set(side * 0.27, 0.52, 0);
    sh.rotation.set(P.arm[i][0], 0, side * P.arm[i][1]);
    const el = limb(0.24, 0.047, mats.skin);
    el.position.y = -0.31;
    el.rotation.x = P.elbow[i];
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.052, 10, 8), mats.skin);
    hand.position.y = -0.3;
    el.add(hand);
    sh.add(el);
    spine.add(sh);
    hands.push(hand);
  });
  root.traverse((o) => { if (o.isMesh && !o.material.transparent) o.castShadow = true; });
  return { root, hands, head, ball: P.ball };
}

// ---------- the engraving pass ----------
const ENGRAVE = {
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  fragmentShader: `
    uniform sampler2D tColor; uniform sampler2D tDepth;
    uniform vec2 uRes; uniform float uNear, uFar, uDraw, uScale;
    uniform vec3 uInk, uPaper;
    varying vec2 vUv;
    float lin(float d) { float z = d * 2. - 1.; return (2. * uNear * uFar) / (uFar + uNear - z * (uFar - uNear)); }
    float lum(vec2 uv) { return dot(pow(texture2D(tColor, uv).rgb, vec3(1. / 2.2)), vec3(.299, .587, .114)); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float hatch(vec2 f, vec2 dir, float spacing, float width) {
      float t = abs(fract(dot(f, dir) / spacing) - .5) * 2.;
      return 1. - smoothstep(width - .22, width + .02, t);
    }
    void main() {
      vec2 px = 1. / uRes;
      float L = lum(vUv);
      // outlines: where the depth surface bends (the Laplacian is zero across flat planes)
      float d = lin(texture2D(tDepth, vUv).x);
      float lap = abs(lin(texture2D(tDepth, vUv + vec2(px.x, 0.)).x) + lin(texture2D(tDepth, vUv - vec2(px.x, 0.)).x)
                    + lin(texture2D(tDepth, vUv + vec2(0., px.y)).x) + lin(texture2D(tDepth, vUv - vec2(0., px.y)).x) - 4. * d);
      float edge = smoothstep(.006 * d, .02 * d, lap);
      float lx = lum(vUv + vec2(px.x, 0.)) - lum(vUv - vec2(px.x, 0.));
      float ly = lum(vUv + vec2(0., px.y)) - lum(vUv - vec2(0., px.y));
      edge = max(edge, smoothstep(.22, .42, abs(lx) + abs(ly)));
      // cross-hatching, denser and darker as the tone drops
      vec2 f = gl_FragCoord.xy / uScale;
      float ink = 0.;
      ink = max(ink, hatch(f, normalize(vec2(1., 1.)), 4.2, clamp((.86 - L) * 1.55, 0., .85)));
      ink = max(ink, hatch(f, normalize(vec2(1., -1.)), 4.2, clamp((.56 - L) * 1.7, 0., .85)));
      ink = max(ink, hatch(f, vec2(0., 1.), 3.4, clamp((.32 - L) * 2.2, 0., .9)));
      ink = max(ink, smoothstep(.12, .04, L));
      ink = max(ink, edge);
      // the drawing inks in from left to right on load, with a ragged nib
      float n = hash(floor(gl_FragCoord.xy / 3.));
      ink *= step(vUv.x * .7 + n * .3, uDraw);
      vec3 col = mix(uPaper, uInk, ink * .94);
      col *= 1. - hash(gl_FragCoord.xy) * .02;
      gl_FragColor = vec4(col, 1.);
    }`,
};

// ---------- the two teams ----------
// Underpriced players attack the right hoop, overpriced players the left. Spots are measured from
// the hoop each side attacks (x toward half court, z across the floor).
const SPOTS = { PG: [7.5, 0.6], SG: [5.6, 4.6], SF: [1.6, -6.5], PF: [4.7, -2.0], C: [1.25, 1.9] };
const POSES_BY_SLOT = { PG: 'dribble', SG: 'jumpshot', SF: 'set', PF: 'defend', C: 'post' };
const SLOT_NAMES = { PG: 'Point guard', SG: 'Shooting guard', SF: 'Small forward', PF: 'Power forward', C: 'Center' };

// ---------- camera: three framings, plus whatever the user drags to ----------
const ease = (t) => t * t * (3 - 2 * t);
// where the scroll walk pauses: progress -> view
const WALK = [[0, 'court'], [0.12, 'court'], [0.38, 'under'], [0.54, 'under'], [0.8, 'over'], [1, 'over']];
const CENTRE = { court: 0.05, under: 0.46, over: 0.9 };
const VIEWS = {
  court: { target: [0, 0, 1.2], radius: 34, polar: 0.84, az: 0 },
  under: { target: [HOOP_X - 4.6, 0.9, 0.3], radius: 13.5, polar: 1.12, az: -0.62 },
  over: { target: [-(HOOP_X - 4.6), 0.9, -0.3], radius: 13.5, polar: 1.12, az: Math.PI - 0.62 },
};

// teams: { under: [player], over: [player] }, each player { id, name, fpg, gap, slot, jersey, height, weight }
export function mountStage({ canvas, labels, section, teams, onSelect, onView, avoid }) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = innerWidth < 760;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch {
    section.classList.add('no-webgl');
    return { destroy() {}, view() {}, select() {} };
  }
  const dpr = Math.min(devicePixelRatio, small ? 1.5 : 2);
  renderer.setPixelRatio(dpr);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(1, 1, 1);
  scene.fog = new THREE.Fog(0xffffff, 32, 60);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 120);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(COURT.L, COURT.W), new THREE.MeshLambertMaterial({ map: courtTexture() }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // a hoop at each end
  const steel = new THREE.MeshLambertMaterial({ color: grey(0.35) });
  for (const side of [-1, 1]) {
    const hoop = new THREE.Group();
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3.3, 0.22), steel); post.position.set(1.25, 1.65, 0);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.14, 0.14), steel); arm.position.set(0.68, 3.2, 0);
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.07, 1.83), new THREE.MeshLambertMaterial({ color: grey(0.95) })); board.position.set(0, 3.35, 0);
    const square = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.45, 0.6), new THREE.MeshLambertMaterial({ color: grey(0.2) })); square.position.set(-0.01, 3.2, 0);
    const inner = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.38, 0.52), new THREE.MeshLambertMaterial({ color: grey(0.95) })); inner.position.set(-0.012, 3.2, 0);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.02, 8, 36), new THREE.MeshLambertMaterial({ color: grey(0.15) }));
    rim.rotation.x = Math.PI / 2; rim.position.set(-0.38, 3.05, 0);
    const net = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.14, 0.42, 14, 3, true), new THREE.MeshLambertMaterial({ color: grey(0.75), wireframe: true }));
    net.position.set(-0.38, 2.83, 0);
    hoop.add(post, arm, board, square, inner, rim, net);
    hoop.position.x = side * (COURT.L / 2 - 1.2);
    if (side < 0) hoop.rotation.y = Math.PI;
    hoop.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(hoop);
  }

  scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-4, 16, 9);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 10, bottom: -10, near: 1, far: 45 });
  sun.shadow.bias = -0.0008;
  scene.add(sun, sun.target);

  const base = {
    skin: new THREE.MeshLambertMaterial({ color: grey(0.42) }),
    shoe: new THREE.MeshLambertMaterial({ color: grey(0.18) }),
    ring: new THREE.MeshBasicMaterial({ color: grey(0.05) }),
    ball: new THREE.MeshLambertMaterial({ color: grey(0.5) }),
  };
  // home and away: light kit for the underpriced side, dark kit for the overpriced side
  const kits = {
    under: { ...base, jersey: new THREE.MeshLambertMaterial({ color: grey(0.86) }), shorts: new THREE.MeshLambertMaterial({ color: grey(0.7) }), ink: '#111' },
    over: { ...base, jersey: new THREE.MeshLambertMaterial({ color: grey(0.2) }), shorts: new THREE.MeshLambertMaterial({ color: grey(0.14) }), ink: '#f4f4f4' },
  };

  const all = [teams.under || [], teams.over || []];
  const maxFp = Math.max(...all.flat().map((p) => p.fpg), 1);
  const figures = [];
  for (const [side, list] of [['under', teams.under || []], ['over', teams.over || []]]) {
    const dir = side === 'under' ? 1 : -1;
    list.forEach((pl, i) => {
      const [dx, dz] = SPOTS[pl.slot] || [6, (i - 2) * 2.5];
      const x = dir * (HOOP_X - dx), z = dir * dz;
      const fig = makePlayer(POSES_BY_SLOT[pl.slot] || 'set', pl.jersey, kits[side]);
      const tall = (pl.height || 79) / 79, wide = Math.sqrt((pl.weight || 220) / 220);
      fig.root.scale.set(wide, tall, wide);
      fig.root.position.set(x, 0, z);
      fig.root.lookAt(dir * HOOP_X, 0, 0);
      scene.add(fig.root);
      const r = 0.45 + 0.75 * (pl.fpg / maxFp);
      const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.05, 64), base.ring);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.006, z);
      scene.add(ring);
      if (fig.ball) {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 14), base.ball);
        ball.castShadow = true;
        fig.root.updateMatrixWorld(true);
        const hand = new THREE.Vector3();
        fig.hands[1].getWorldPosition(hand);
        ball.position.copy(hand).add(new THREE.Vector3(0, fig.ball === 'shot' ? 0.13 : -0.55, 0));
        if (fig.ball === 'dribble') ball.position.y = Math.max(0.35, ball.position.y);
        scene.add(ball);
      }
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `col-label ${side === 'under' ? 'up' : 'down'}`;
      el.innerHTML = '<b></b><span></span>';
      el.querySelector('b').textContent = `${pl.name}${pl.jersey ? ` #${pl.jersey}` : ''}`;
      el.querySelector('span').textContent = `${pl.slot} · ${pl.fpg.toFixed(1)} proj · ${side === 'under' ? 'under' : 'over'}priced ${Math.abs(pl.gap).toFixed(1)}`;
      el.title = SLOT_NAMES[pl.slot] || '';
      labels.append(el);
      const f = { pl, side, root: fig.root, ring, el, face: fig.root.rotation.y, head: new THREE.Vector3(x, 2.45 * tall, z) };
      fig.root.traverse((o) => { o.userData.figure = f; });
      el.onclick = () => select(f);
      el.onmouseenter = () => { hovered = f; };
      el.onmouseleave = () => { if (hovered === f) hovered = null; };
      figures.push(f);
    });
  }

  // engraving pass
  const rt = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1) });
  const engrave = new THREE.ShaderMaterial({
    ...ENGRAVE,
    uniforms: {
      tColor: { value: rt.texture }, tDepth: { value: rt.depthTexture },
      uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: camera.near }, uFar: { value: camera.far },
      uDraw: { value: still ? 2 : 0 }, uScale: { value: dpr },
      uInk: { value: rgb(css('--accent') || '#3a2f86') }, uPaper: { value: rgb(css('--bg') || '#efe8da') },
    },
    depthTest: false, depthWrite: false,
  });
  const postScene = new THREE.Scene();
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), engrave));
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  if (!still) gsap.to(engrave.uniforms.uDraw, { value: 1.35, duration: 2.2, ease: 'power2.inOut', delay: 0.15 });

  // ---------- camera state ----------
  // `cam` is where the walk (or a button) puts the camera; `user` is the turn you add by dragging.
  const cam = { tx: 0, ty: 0, tz: 0, radius: 27, polar: 0.92, az: 0 };
  const user = { az: 0, polar: 0 };
  const params = (name) => { const v = VIEWS[name]; return { tx: v.target[0], ty: v.target[1], tz: v.target[2], radius: v.radius * (camera.aspect < 1 ? 1.45 : 1), polar: v.polar, az: v.az }; };
  let mode = 'court';
  const setMode = (name) => {
    if (name === mode) return;
    mode = name;
    // a new stop on the walk: drop your turn and let go of a player from the other team
    gsap.to(user, { az: 0, polar: 0, duration: still ? 0 : 0.9, ease: 'power2.out' });
    if (selected && name !== 'court' && selected.side !== name) select(selected);
    onView?.(name);
  };
  const walk = { p: 0, target: 0 };
  const walkCam = (p) => {
    let i = 0;
    while (i < WALK.length - 2 && p > WALK[i + 1][0]) i++;
    const [p0, a] = WALK[i], [p1, b] = WALK[i + 1];
    const t = ease(Math.min(1, Math.max(0, (p - p0) / Math.max(1e-6, p1 - p0))));
    const A = params(a), B = params(b);
    for (const k of Object.keys(A)) cam[k] = A[k] + (B[k] - A[k]) * t;
    setMode(p < 0.25 ? 'court' : p < 0.67 ? 'under' : 'over');
  };
  let trigger = null;
  if (!still) {
    trigger = ScrollTrigger.create({ trigger: section, start: 'top top', end: 'bottom bottom', onUpdate: (self) => { walk.target = self.progress; } });
  }
  const apply = (name, instant) => {
    if (trigger && !instant) {
      // buttons move along the walk, so the page and the camera never disagree
      const y = trigger.start + (trigger.end - trigger.start) * CENTRE[name];
      scrollTo({ top: y, behavior: 'smooth' });
      return;
    }
    Object.assign(cam, params(name));
    setMode(name);
    onView?.(name);
  };

  // ---------- selection ----------
  let selected = null, hovered = null;
  function select(f) {
    if (selected) {
      gsap.to(selected.root.rotation, { y: selected.face, duration: still ? 0 : 0.6, ease: 'power2.out' });
      gsap.killTweensOf(selected.ring.scale);
      selected.ring.scale.set(1, 1, 1);
    }
    selected = f === selected ? null : f;
    if (selected) {
      // he turns to face you, and his ring pulses
      const toCam = Math.atan2(camera.position.x - selected.root.position.x, camera.position.z - selected.root.position.z);
      gsap.to(selected.root.rotation, { y: toCam, duration: still ? 0 : 0.7, ease: 'power2.out' });
      if (!still) gsap.to(selected.ring.scale, { x: 1.18, y: 1.18, z: 1.18, duration: 0.8, yoyo: true, repeat: -1, ease: 'sine.inOut' });
      if (mode === 'court') apply(selected.side);
    }
    onSelect?.(selected ? { ...selected.pl, side: selected.side } : null);
  }

  // ---------- pointer: drag to turn, hover to name, click to select ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const pick = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(figures.map((f) => f.root), true)[0];
    return hit?.object.userData.figure || null;
  };
  let drag = null;
  const down = (e) => { drag = { x: e.clientX, y: e.clientY, az: user.az, polar: user.polar, moved: false, touch: e.pointerType === 'touch' }; };
  const move = (e) => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        gsap.killTweensOf(user);
        user.az = Math.max(-1.5, Math.min(1.5, drag.az - dx * 0.006));
        if (!drag.touch) user.polar = Math.max(-0.45, Math.min(0.4, drag.polar - dy * 0.004));
      }
    } else if (e.pointerType === 'mouse') {
      hovered = pick(e);
      canvas.style.cursor = hovered ? 'pointer' : 'grab';
    }
  };
  const up = (e) => {
    if (drag && !drag.moved) {
      const f = pick(e);
      if (f) select(f);
      else if (selected) select(selected);
    }
    drag = null;
  };
  canvas.addEventListener('pointerdown', down);
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  const key = (e) => { if (e.key === 'Escape' && selected) select(selected); };
  addEventListener('keydown', key);

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    rt.setSize(Math.round(w * dpr), Math.round(h * dpr));
    engrave.uniforms.uRes.value.set(Math.round(w * dpr), Math.round(h * dpr));
    camera.aspect = w / h;
    camera.fov = w < 760 ? 48 : 36;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  apply('court', true);

  const v = new THREE.Vector3();
  const t0 = performance.now();
  let raf = 0, visible = true;
  const frame = (now) => {
    raf = 0;
    if (!visible || document.hidden) return;
    const drift = still || drag || selected ? 0 : Math.sin((now - t0) / 5200) * 0.06;
    if (trigger) { walk.p += (walk.target - walk.p) * 0.12; walkCam(walk.p); }
    const az = cam.az + user.az + drift;
    const polar = Math.max(0.5, Math.min(1.35, cam.polar + user.polar));
    camera.position.set(cam.tx + cam.radius * Math.sin(polar) * Math.sin(az), cam.ty + cam.radius * Math.cos(polar), cam.tz + cam.radius * Math.sin(polar) * Math.cos(az));
    camera.lookAt(cam.tx, cam.ty, cam.tz);
    // name plates: the side in view, plus whoever is hovered or selected
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const placed = [];
    const box = canvas.getBoundingClientRect();
    const blocked = (avoid?.() || []).map((r) => [r.left - box.left - 10, r.top - box.top - 10, r.right - box.left + 10, r.bottom - box.top + 10]);
    const order = [...figures].sort((a, b) => (b === selected) - (a === selected) || (b === hovered) - (a === hovered) || a.head.distanceTo(camera.position) - b.head.distanceTo(camera.position));
    for (const f of order) {
      v.copy(f.head).project(camera);
      const sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h;
      const wanted = f === selected || f === hovered || (mode !== 'court' && f.side === mode && w >= 760);
      const covered = blocked.some(([l, t, r, b]) => sx + 95 > l && sx - 95 < r && sy > t && sy - 50 < b);
      const clear = !covered && (f === selected || !placed.some(([x, y]) => Math.abs(x - sx) < 150 && Math.abs(y - sy) < 46));
      const on = wanted && clear && v.z < 1 && v.x > -1.05 && v.x < 1.05;
      if (on) placed.push([sx, sy]);
      f.el.style.transform = `translate(${Math.min(w - 80, Math.max(80, sx))}px, ${sy}px) translate(-50%, -100%)`;
      f.el.style.opacity = on ? 1 : 0;
      f.el.style.pointerEvents = on ? 'auto' : 'none';
      f.el.classList.toggle('on', f === selected);
      f.el.tabIndex = on ? 0 : -1;
    }
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
    raf = requestAnimationFrame(frame);
  };
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) raf = requestAnimationFrame(frame);
  });
  io.observe(section);
  raf = requestAnimationFrame(frame);

  return {
    view: (name) => { if (VIEWS[name]) apply(name); },
    select: (id) => { const f = figures.find((x) => x.pl.id === id); if (f !== selected) select(f || selected); },
    destroy() {
      cancelAnimationFrame(raf);
      trigger?.kill();
      gsap.killTweensOf(user);
      gsap.killTweensOf(engrave.uniforms.uDraw);
      for (const f of figures) { gsap.killTweensOf(f.ring.scale); gsap.killTweensOf(f.root.rotation); }
      canvas.removeEventListener('pointerdown', down);
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('keydown', key);
      io.disconnect(); ro.disconnect();
      labels.textContent = '';
      rt.dispose();
      renderer.dispose();
      scene.traverse((o) => { o.geometry?.dispose(); if (o.material) { o.material.map?.dispose(); o.material.dispose(); } });
    },
  };
}
