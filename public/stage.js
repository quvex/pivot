// The front page's etched court. The scene is lit and rendered in greys, then a post-process
// shader redraws it as an engraving: purple ink on cream paper, with cross-hatching that gets
// denser in shadow and outlines found from the depth buffer.
// Two teams take the floor: the most underpriced player at each position on the right, the most
// overpriced on the left, each a rigged human figure built to his real height, posed for his
// position and wearing his number, on a ring sized
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
  // heavy block numerals, like a real jersey: thin type disappears once it is engraved
  g.fillStyle = ink; g.strokeStyle = ink; g.lineWidth = 7; g.lineJoin = 'round';
  g.font = `800 ${num.length > 1 ? 84 : 100}px "Hanken Grotesk", "Arial Black", Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.strokeText(num, 64, 68);
  g.fillText(num, 64, 68);
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

// ---------- the bodies: a realistic human, posed by a puppet ----------
// Each player is a realistic male base mesh (CC0, by Orange Juice Games, in public/models), reshaped
// to his listed height and weight and dressed in a basketball kit. It is posed by an invisible
// puppet: Mixamo's X Bot (as shipped in three.js's examples), which keeps breathing with its idle
// animation and is bent into a basketball stance by adding a rotation to a handful of joints every
// frame. If the realistic body cannot load, the puppet itself is shown, reshaped and dressed.
const BODY_URL = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/models/gltf/Xbot.glb';
const REAL_URL = new URL('./models/male-base.glb', import.meta.url).href;
// jersey numbers are real geometry in a bold face, raised slightly off the chest
const NUMBER_FONT = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/fonts/helvetiker_bold.typeface.json';
let bodyPromise = null;
function loadBody() {
  bodyPromise ||= Promise.all([
    import('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/GLTFLoader.js/+esm'),
    import('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/utils/SkeletonUtils.js/+esm'),
    import('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/FontLoader.js/+esm'),
    import('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/geometries/TextGeometry.js/+esm'),
  ]).then(async ([{ GLTFLoader }, { clone }, { FontLoader }, { TextGeometry }]) => {
    const loader = new GLTFLoader();
    const [gltf, realGltf, font] = await Promise.all([
      loader.loadAsync(BODY_URL),
      loader.loadAsync(REAL_URL).catch(() => null),
      new FontLoader().loadAsync(NUMBER_FONT).catch(() => null),
    ]);
    const asset = (g, frame, chestLift) => {
      const box = new THREE.Box3().setFromObject(g.scene);
      const kit = {};
      g.scene.traverse((o) => { if (o.isSkinnedMesh) kit[o.name] = planKit(o); });
      g.scene.updateMatrixWorld(true);
      const hb = bonesOf(g.scene);
      const headAbove = hb.Head ? box.max.y - hb.Head.getWorldPosition(new THREE.Vector3()).y : 0.12;
      return { gltf: g, height: box.max.y - box.min.y, kit, frame, chestLift, headAbove, GLTFLoader };
    };
    const puppet = asset(gltf, MANNEQUIN_FRAME, 0.07);
    return { ...puppet, clone, font, TextGeometry, real: realGltf ? asset(realGltf, HUMAN_FRAME, 0.02) : null };
  });
  return bodyPromise;
}

// The kit is cut from the body itself: each vertex goes to the jersey, the shorts or the shoes by
// which bones move it most, and the cloth stands off the skin along the surface normal. Because the
// pieces keep the body's skin weights they bend with it in every pose. Offsets are in metres on the
// unscaled model.
const GARMENTS = {
  jersey: { bones: ['Spine', 'Spine1', 'Spine2', 'LeftShoulder', 'RightShoulder'], out: 0.011, hang: 0.026 },
  shorts: { bones: ['Hips', 'LeftUpLeg', 'RightUpLeg'], out: 0.01, flare: 0.022 },
  shoes: { bones: ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase', 'LeftToe_End', 'RightToe_End'], out: 0.014 },
};
const SKIN_BONES = ['Neck', 'Head', 'HeadTop_End', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand', 'LeftHandFinger', 'RightHandFinger', 'LeftLeg', 'RightLeg'];
// the realistic mesh uses Blender's Rigify names; everything here speaks Mixamo's
const RIGIFY = { spine: 'Hips', spine001: 'Spine', spine002: 'Spine1', spine003: 'Spine2', spine004: 'Neck', spine005: 'Head' };
for (const [s, side] of [['L', 'Left'], ['R', 'Right']]) {
  Object.assign(RIGIFY, {
    [`shoulder${s}`]: `${side}Shoulder`, [`upper_arm${s}`]: `${side}Arm`, [`forearm${s}`]: `${side}ForeArm`, [`hand${s}`]: `${side}Hand`,
    [`f_middle01${s}`]: `${side}HandMiddle1`, [`pelvis${s}`]: 'Hips', [`thigh${s}`]: `${side}UpLeg`, [`shin${s}`]: `${side}Leg`,
    [`foot${s}`]: `${side}Foot`, [`heel02${s}`]: `${side}Foot`, [`toe${s}`]: `${side}ToeBase`,
  });
}
const boneName = (b) => {
  const n = b.name.replace(/^mixamorig:?/, '');
  if (RIGIFY[n]) return RIGIFY[n];
  const finger = /^(?:f_\w+|thumb\d+)([LR])$/.exec(n);
  return finger ? `${finger[1] === 'L' ? 'Left' : 'Right'}HandFinger` : n;
};

// once per model: which triangles each garment keeps, and how far each of its vertices stands off
function planKit(src) {
  const g = src.geometry, names = src.skeleton.bones.map(boneName);
  const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, pos = g.attributes.position;
  const n = pos.count, owner = new Int8Array(n).fill(-1), legs = new Float32Array(n), waist = new Float32Array(n);
  const kinds = Object.entries(GARMENTS);
  const cover = kinds.map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const score = new Float32Array(kinds.length + 1);
    for (let k = 0; k < 4; k++) {
      const name = names[si.getComponent(i, k)], wt = sw.getComponent(i, k);
      kinds.forEach(([, gm], j) => { if (gm.bones.includes(name)) score[j] += wt; });
      if (SKIN_BONES.includes(name) || /Hand|Head/.test(name)) score[kinds.length] += wt;
      if (/UpLeg$/.test(name)) legs[i] += wt;
      if (name === 'Spine' || name === 'Hips') waist[i] += wt;
    }
    let best = kinds.length;
    for (let j = 0; j < kinds.length; j++) if (score[j] > score[best]) best = j;
    owner[i] = best < kinds.length ? best : -1;
    // how firmly each garment holds this vertex: 0.5 exactly where it gives way to the next thing
    for (let j = 0; j < kinds.length; j++) {
      let rival = 0;
      for (let r = 0; r <= kinds.length; r++) if (r !== j) rival = Math.max(rival, score[r]);
      cover[j][i] = 0.5 + 0.5 * (score[j] - rival);
    }
  }
  g.computeBoundingBox();
  const hip = g.boundingBox.min.y + (g.boundingBox.max.y - g.boundingBox.min.y) * 0.53;
  const idx = g.index ? g.index.array : Array.from({ length: n }, (_, i) => i);
  const skin = [];
  for (let t = 0; t < idx.length; t += 3) {
    if ((owner[idx[t]] === -1) + (owner[idx[t + 1]] === -1) + (owner[idx[t + 2]] === -1) >= 2) skin.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const garments = kinds.map(([name, gm], j) => {
    const tris = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      // every triangle the garment touches; the hem is then cut smoothly across them in the shader
      if (owner[a] === j || owner[b] === j || owner[c] === j) tris.push(a, b, c);
    }
    // the shorts flare the further down the thigh they go; the jersey hangs straight off the chest
    const off = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const drop = gm.flare ? Math.max(0, Math.min(1, (hip - pos.getY(i)) / 0.36)) ** 1.5 * legs[i] : 0;
      off[i] = gm.out + (gm.flare || 0) * drop + (gm.hang || 0) * Math.min(1, waist[i]);
    }
    return { name, tris, off, cover: cover[j] };
  });
  // each bone's line at rest, in the mesh's own space: from its head toward its main child
  src.updateMatrixWorld(true);
  const bones = src.skeleton.bones, tmp = new THREE.Vector3();
  const head = bones.map((bo) => src.worldToLocal(bo.getWorldPosition(tmp.clone())));
  const axis = bones.map((bo, i) => {
    const kids = bo.children.filter((c) => c.isBone);
    const want = NEXT_BONE[boneName(bo)];
    const next = (want && kids.find((c) => boneName(c) === want)) || kids.find((c) => /Spine|Neck|Head$/.test(boneName(c))) || kids[0];
    const j = next ? bones.indexOf(next) : -1;
    return j >= 0 ? head[j].clone().sub(head[i]).normalize() : null;
  });
  // the body without its head, for when a face is set on it
  const headW = new Float32Array(n);
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) if (/^Head/.test(names[si.getComponent(i, k)])) headW[i] += sw.getComponent(i, k);
  const noHead = [];
  for (let t = 0; t < idx.length; t += 3) {
    if ((headW[idx[t]] > 0.5) + (headW[idx[t + 1]] > 0.5) + (headW[idx[t + 2]] > 0.5) < 2) noHead.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  return { skin, garments, head, axis, noHead };
}

// His frame. Every vertex is moved toward or away from the line of the bone that carries it (girth
// only, never length), by a factor per bone: an athletic base for the model, then thicker or
// leaner by his body mass index against a typical NBA frame (about 6'7" and 218 lb). The mannequin
// needs a lot of help (narrow waist, broad hips); the realistic body only a little.
const MANNEQUIN_FRAME = { Hips: 0.74, Spine: 1.34, Spine1: 1.2, Spine2: 1.1, Shoulder: 1.15, Arm: 1.1, ForeArm: 1.05, UpLeg: 0.8, Leg: 0.94, Neck: 1.2 };
const HUMAN_FRAME = { Hips: 1, Spine: 1.04, Spine1: 1.04, Spine2: 1.05, Shoulder: 1.08, Arm: 1.06, ForeArm: 1.03, UpLeg: 1, Leg: 1, Neck: 1.05 };
function girthOf(pl, FRAME) {
  const h = (pl.height || 79) * 0.0254, kg = (pl.weight || 218) * 0.4536;
  const k = Math.max(-0.14, Math.min(0.28, ((kg / (h * h)) - 24.6) / 24.6 * 1.5));
  const out = {};
  for (const [part, base] of Object.entries(FRAME)) {
    const trunk = /Hips|Spine/.test(part);
    out[part] = base * (1 + k * (trunk ? 0.8 : 0.55));
  }
  return out;
}
function shapeGeometry(mesh, girth, { head, axis }) {
  const g = mesh.geometry, bones = mesh.skeleton.bones;
  const factor = bones.map((b) => {
    const name = boneName(b).replace(/^(Left|Right)/, '');
    return girth[name] ?? 1;
  });
  const hips = bones.findIndex((b) => boneName(b) === 'Hips');
  const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const p = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3(), d = new THREE.Vector3(), acc = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    acc.set(0, 0, 0);
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (!w) continue;
      const b = si.getComponent(i, k), ax = axis[b];
      let f = factor[b];
      // the pelvis narrows, but above the hip joint the same bone carries the waist, which fills out
      if (b === hips) f += (girth.Spine - f) * Math.max(0, Math.min(1, (v.y - head[b].y) / 0.07));
      d.subVectors(v, head[b]);
      if (ax && f !== 1) {
        const along = d.dot(ax);
        d.sub(ax.clone().multiplyScalar(along)).multiplyScalar(f).addScaledVector(ax, along);
      }
      acc.addScaledVector(d.add(head[b]), w);
      total += w;
    }
    if (total) acc.divideScalar(total); else acc.copy(v);
    p[i * 3] = acc.x; p[i * 3 + 1] = acc.y; p[i * 3 + 2] = acc.z;
  }
  const geo = g.clone();
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  return geo;
}
// Cloth: an ordinary material that drops every pixel the garment does not cover, so a hem runs in
// a clean line across the body's triangles rather than following their edges.
function cloth(color) {
  const m = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float cover;\nvarying float vCover;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCover = cover;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCover;')
      .replace('#include <clipping_planes_fragment>', 'if (vCover < 0.5) discard;\n#include <clipping_planes_fragment>');
  };
  m.customProgramCacheKey = () => 'cloth';
  return m;
}
function garmentGeometry(shaped, plan) {
  const pos = shaped.attributes.position, nor = shaped.attributes.normal, n = pos.count;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = plan.off[i];
    p[i * 3] = pos.getX(i) + nor.getX(i) * o;
    p[i * 3 + 1] = pos.getY(i) + nor.getY(i) * o;
    p[i * 3 + 2] = pos.getZ(i) + nor.getZ(i) * o;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  geo.setAttribute('normal', nor);
  geo.setAttribute('skinIndex', shaped.attributes.skinIndex);
  geo.setAttribute('skinWeight', shaped.attributes.skinWeight);
  geo.setAttribute('cover', new THREE.BufferAttribute(plan.cover, 1));
  geo.setIndex(plan.tris);
  return geo;
}

// Stances: a rotation added on top of the idle breathing for a handful of the puppet's joints.
// Axes (X Bot, found by posing it and looking): for the left arm, y swings it forward and z lifts it
// out to the side (the right arm mirrors both), and x twists it, which here turns the elbows in so
// the hands meet in front; a forearm's z bends the elbow (again mirrored); for a leg, x bends the
// hip (negative, thigh forward) and the knee (positive); a foot's x keeps the sole flat.
// A player blends from one stance to the next, so a catch or a pass reads as a movement.
const STANCES = {
  // off the ball: knees bent, weight forward, hands up and ready
  ready: { Spine: [0.16, 0, 0], LeftUpLeg: [-0.42, 0, 0.06], RightUpLeg: [-0.42, 0, -0.06], LeftLeg: [0.72, 0, 0], RightLeg: [0.72, 0, 0], LeftFoot: [-0.3, 0, 0], RightFoot: [-0.3, 0, 0], LeftArm: [-0.6, 0.5, 0.05], RightArm: [-0.6, -0.5, -0.05], LeftForeArm: [0, 0, 0.85], RightForeArm: [0, 0, -0.85] },
  // on the ball: lower, the right hand working the ball at the hip, the left arm guarding it
  dribble: { Spine: [0.3, 0, 0], LeftUpLeg: [-0.55, 0, 0.08], RightUpLeg: [-0.5, 0, -0.08], LeftLeg: [0.9, 0, 0], RightLeg: [0.85, 0, 0], LeftFoot: [-0.35, 0, 0], RightFoot: [-0.35, 0, 0], LeftArm: [-0.9, 0.95, 0.1], RightArm: [-0.5, -0.45, -0.3], LeftForeArm: [0, 0, 0.9], RightForeArm: [0, 0, -0.45] },
  // a pass on its way: square up, both hands out together at the chest
  catch: { Spine: [0.1, 0, 0], LeftUpLeg: [-0.3, 0, 0.05], RightUpLeg: [-0.3, 0, -0.05], LeftLeg: [0.5, 0, 0], RightLeg: [0.5, 0, 0], LeftFoot: [-0.2, 0, 0], RightFoot: [-0.2, 0, 0], LeftArm: [-0.9, 1.1, -0.15], RightArm: [-0.9, -1.1, 0.15], LeftForeArm: [0, 0, 0.8], RightForeArm: [0, 0, -0.8] },
  // a chest pass at its follow-through: arms punched straight out, leaning into it
  pass: { Spine: [0.28, 0, 0], LeftUpLeg: [-0.5, 0, 0.05], RightUpLeg: [-0.2, 0, -0.05], LeftLeg: [0.6, 0, 0], RightLeg: [0.35, 0, 0], LeftFoot: [-0.1, 0, 0], RightFoot: [-0.15, 0, 0], LeftArm: [-0.4, 1.4, -0.15], RightArm: [-0.4, -1.4, 0.15], LeftForeArm: [0, 0, 0.15], RightForeArm: [0, 0, -0.15] },
};
const stEuler = new THREE.Euler(), stQ = new THREE.Quaternion();
function applyStance(f, dt, snap) {
  const rot = STANCES[f.stance] || {};
  const k = snap || dt >= 1 ? 1 : 1 - Math.exp(-dt * 10);
  const names = new Set(Object.values(STANCES).flatMap((s) => Object.keys(s)));
  for (const name of names) {
    const bone = f.pBones[name];
    if (!bone) continue;
    let cur = f.cur.get(name);
    if (!cur) f.cur.set(name, (cur = new THREE.Quaternion()));
    const r = rot[name];
    stQ.setFromEuler(r ? stEuler.set(r[0], r[1], r[2]) : stEuler.set(0, 0, 0));
    cur.slerp(stQ, k);
    bone.quaternion.multiply(cur);
  }
}
// keep him standing on the floor: the lower of his feet rests where it rests in the idle pose
const plantV = new THREE.Vector3();
function plant(f) {
  f.puppet.position.y = 0;
  f.puppet.updateMatrixWorld(true);
  let low = Infinity;
  for (const b of f.feet) low = Math.min(low, b.getWorldPosition(plantV).y);
  if (Number.isFinite(low)) f.puppet.position.y = f.footRest - low;
}

function dressFigure(f, body, kit, base) {
  // the puppet: the Mixamo model, which holds the stance and the breathing
  const puppet = body.clone(body.gltf.scene);
  puppet.scale.setScalar(f.metres / body.height);
  f.root.add(puppet);
  const pBones = bonesOf(puppet);
  f.puppet = puppet;
  f.pBones = pBones;
  f.cur = new Map();
  f.feet = [pBones.LeftToeBase, pBones.RightToeBase, pBones.LeftFoot, pBones.RightFoot].filter(Boolean);

  // what is seen: the realistic body when it loaded, following the puppet; otherwise the puppet
  const real = body.real;
  let shown = puppet, asset = body;
  if (real) {
    puppet.traverse((o) => { if (o.isMesh) o.visible = false; });
    const model = body.clone(real.gltf.scene);
    const wrap = new THREE.Group();
    wrap.rotation.y = -Math.PI / 2; // the model faces +x; turn it to face the way the puppet does
    wrap.scale.setScalar(f.metres / real.height);
    wrap.add(model);
    f.root.add(wrap);
    shown = model; asset = real;
    const rBones = bonesOf(model);
    f.wrap = wrap;
    f.hipPair = [rBones.Hips, pBones.Hips];
    f.pairs = FOLLOW.filter(([a, b]) => rBones[a] && rBones[b] && pBones[a] && pBones[b]).map(([a, b]) => [rBones[a], rBones[b], pBones[a], pBones[b]]);
    matchRest(f);
  }
  // now bring the puppet to life: idle breathing plus the stance
  f.mixer = new THREE.AnimationMixer(puppet);
  const idle = body.gltf.animations.find((a) => a.name === 'idle');
  if (idle) { const act = f.mixer.clipAction(idle); act.time = Math.random() * idle.duration; act.play(); }
  f.mixer.update(0);
  // where his feet rest when he simply stands; every stance keeps the lower foot there
  puppet.updateMatrixWorld(true);
  f.footRest = Math.min(...f.feet.map((bn) => bn.getWorldPosition(new THREE.Vector3()).y));
  f.stance ||= 'ready';
  applyStance(f, 1);
  plant(f);
  if (f.pairs) retarget(f);

  // his frame, then the kit cut to fit it and bound to his skeleton
  const girth = girthOf(f.pl, asset.frame);
  const meshes = [];
  shown.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    o.material = base.skin;
    o.castShadow = true;
    o.frustumCulled = false;
    const plan = o.isSkinnedMesh && asset.kit[o.name];
    if (!plan) continue;
    o.geometry = shapeGeometry(o, girth, plan);
    // the mannequin's separate joint pieces would poke through the kit: keep their bare-skin parts
    // as skin and dress the rest along with the body
    const joints = shown === puppet && !/surface/i.test(o.name);
    for (const g of plan.garments) {
      const cloth = new THREE.SkinnedMesh(garmentGeometry(o.geometry, joints ? { ...g, off: g.off.map((x) => x * 0.6) } : g), g.name === 'shoes' ? base.shoe : kit[g.name]);
      cloth.bind(o.skeleton, o.bindMatrix);
      cloth.castShadow = true;
      cloth.frustumCulled = false;
      o.parent.add(cloth);
    }
    if (joints) o.geometry.setIndex(plan.skin);
    (f.skins ||= []).push({ o, plan });
  }
  const bones = bonesOf(shown);
  f.hands = [bones.LeftHand, bones.RightHand];
  f.headBone = bones.Head;
  f.neckBone = bones.Neck;
  f.headAbove = asset.headAbove * (f.metres / asset.height);
  // his number, front and back. The chest surface is found from the posed (skinned) vertices in a
  // band around chest height; the number sits just off it, then rides on the chest bone so it
  // moves with the breathing and the lean.
  const chest = bones.Spine2;
  if (chest && f.pl.jersey && body.font) {
    f.root.updateMatrixWorld(true);
    const skinned = [];
    shown.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
    const centre = chest.getWorldPosition(new THREE.Vector3());
    centre.y += asset.chestLift * (f.metres / 2);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(f.root.getWorldQuaternion(new THREE.Quaternion())).normalize();
    const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward).normalize();
    const band = 0.07 * (f.metres / 2), half = 0.08 * (f.metres / 2);
    const reach = { front: -Infinity, back: -Infinity };
    const v = new THREE.Vector3(), rel = new THREE.Vector3();
    for (const m of skinned) {
      const n = m.geometry.attributes.position.count;
      for (let i = 0; i < n; i++) {
        m.getVertexPosition(i, v);
        m.localToWorld(v);
        rel.subVectors(v, centre);
        if (Math.abs(rel.y) > band || Math.abs(rel.dot(side)) > half) continue;
        const d = rel.dot(forward);
        if (d > reach.front) reach.front = d;
        if (-d > reach.back) reach.back = -d;
      }
    }
    for (const back of [false, true]) {
      const dir = forward.clone().multiplyScalar(back ? -1 : 1);
      const surface = back ? reach.back : reach.front;
      const at = centre.clone().addScaledVector(dir, (Number.isFinite(surface) ? surface : 0.15) + 0.015);
      const geo = new body.TextGeometry(f.pl.jersey, { font: body.font, size: 0.23 * (f.metres / 2), depth: 0.012, curveSegments: 3 });
      geo.center();
      geo.computeBoundingBox();
      const wide = geo.boundingBox.max.x - geo.boundingBox.min.x, fit = 0.27 * (f.metres / 2);
      if (wide > fit) geo.scale(fit / wide, fit / wide, 1);
      const d = new THREE.Mesh(geo, kit.number);
      f.root.parent.add(d);
      d.position.copy(at);
      d.lookAt(at.clone().add(dir));
      chest.attach(d);
    }
  }
}

function bonesOf(model) {
  const out = {};
  model.traverse((o) => { if (o.isBone) { const n = boneName(o); out[n] ||= o; } });
  return out;
}

// The realistic body follows the puppet bone by bone. Once, at rest, each bone is turned to point
// the same way as its twin (the two rest in different poses, T against A), and the difference in
// orientation that is left (mostly the bones' roll) is recorded. From then on every bone takes its
// twin's orientation with that difference applied, parents first, so twist carries over too.
const FOLLOW = [
  ['Hips', 'Spine'], ['Spine', 'Spine1'], ['Spine1', 'Spine2'], ['Spine2', 'Neck'], ['Neck', 'Head'],
  ...['Left', 'Right'].flatMap((s) => [
    [`${s}Shoulder`, `${s}Arm`], [`${s}Arm`, `${s}ForeArm`], [`${s}ForeArm`, `${s}Hand`], [`${s}Hand`, `${s}HandMiddle1`],
    [`${s}UpLeg`, `${s}Leg`], [`${s}Leg`, `${s}Foot`], [`${s}Foot`, `${s}ToeBase`],
  ]),
];
const NEXT_BONE = Object.fromEntries(FOLLOW);
const rtA = new THREE.Vector3(), rtB = new THREE.Vector3(), rtC = new THREE.Vector3(), rtD = new THREE.Vector3();
const rtQ = new THREE.Quaternion(), rtW = new THREE.Quaternion(), rtP = new THREE.Quaternion();
function placeHips(f) {
  const [rh, ph] = f.hipPair;
  if (!rh || !ph) return;
  f.root.worldToLocal(ph.getWorldPosition(rtA));
  f.root.worldToLocal(rh.getWorldPosition(rtB));
  f.wrap.position.add(rtA.sub(rtB));
  f.wrap.updateMatrixWorld(true);
}
function matchRest(f) {
  f.root.updateMatrixWorld(true);
  placeHips(f);
  for (const [rb, rc, pb, pc] of f.pairs) {
    pb.getWorldPosition(rtA); pc.getWorldPosition(rtB); rtB.sub(rtA).normalize();
    rb.getWorldPosition(rtC); rc.getWorldPosition(rtD); rtD.sub(rtC).normalize();
    rtQ.setFromUnitVectors(rtD, rtB);
    rb.getWorldQuaternion(rtW).premultiply(rtQ);
    rb.parent.getWorldQuaternion(rtP).invert();
    rb.quaternion.copy(rtP.multiply(rtW));
    rb.updateMatrixWorld(true);
  }
  f.offsets = f.pairs.map(([rb, , pb]) => pb.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rb.getWorldQuaternion(new THREE.Quaternion())));
}
function retarget(f) {
  f.root.updateMatrixWorld(true);
  placeHips(f);
  f.pairs.forEach(([rb, , pb], i) => {
    pb.getWorldQuaternion(rtW).multiply(f.offsets[i]);
    rb.parent.getWorldQuaternion(rtP).invert();
    rb.quaternion.copy(rtP.multiply(rtW));
    rb.updateMatrixWorld(true);
  });
  placeHips(f);
}

// every frame: breathe, blend toward his stance, keep his feet on the floor, carry the realistic
// body along
function animateFigure(f, dt, snap) {
  if (!f.mixer) return;
  f.mixer.update(dt);
  applyStance(f, dt, snap);
  plant(f);
  if (f.pairs) retarget(f);
}

// ---------- faces: made on this computer only ----------
// A face is a 3D bust made from the player's photo by TripoSR on this computer (lib/heads.mjs). The bust is trimmed at
// the neck (the narrowest slice above the shoulders), sized to the body's head, set on it facing
// the way he faces, and carried by the head bone; the body's own head is hidden under it.
async function attachFace(f, url, GLTFLoader) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const bust = gltf.scene;
  bust.updateMatrixWorld(true);
  const meshes = [];
  bust.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const box = new THREE.Box3().setFromObject(bust);
  const H = box.max.y - box.min.y;
  if (!meshes.length || !(H > 0)) return;
  // width of the bust in horizontal slices, top to bottom
  const N = 24, lo = new Array(N).fill(Infinity), hi = new Array(N).fill(-Infinity);
  const v = new THREE.Vector3();
  const slice = (y) => Math.min(N - 1, Math.max(0, Math.floor(((box.max.y - y) / H) * N)));
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const s = slice(v.y);
      lo[s] = Math.min(lo[s], v.x); hi[s] = Math.max(hi[s], v.x);
    }
  }
  const width = lo.map((l, i) => (hi[i] > l ? hi[i] - l : 0));
  let neck = -1, narrow = Infinity;
  for (let i = Math.round(N * 0.35); i <= Math.round(N * 0.85); i++) if (width[i] > 0 && width[i] < narrow) { narrow = width[i]; neck = i; }
  const shoulders = neck >= 0 && Math.max(...width.slice(neck + 1)) > narrow * 1.5;
  const cut = shoulders ? box.max.y - ((neck + 0.5) / N) * H : -Infinity;
  // drop everything below the neck; measure what is left
  const kept = new THREE.Box3();
  for (const m of meshes) {
    const g = m.geometry, pos = g.attributes.position;
    const idx = g.index ? g.index.array : Array.from({ length: pos.count }, (_, i) => i);
    const ys = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); ys[i] = v.y; if (v.y >= cut) kept.expandByPoint(v); }
    const tris = [];
    for (let t = 0; t < idx.length; t += 3) if (ys[idx[t]] >= cut || ys[idx[t + 1]] >= cut || ys[idx[t + 2]] >= cut) tris.push(idx[t], idx[t + 1], idx[t + 2]);
    g.setIndex(tris);
    // a bust with no normals would light black
    if (!g.attributes.normal) g.computeVertexNormals();
    const map = m.material?.map || null, painted = Boolean(g.attributes.color);
    m.material = new THREE.MeshLambertMaterial({ map, vertexColors: painted, color: map || painted ? 0xffffff : 0x9a9a9a });
    m.castShadow = true;
    m.frustumCulled = false;
  }
  if (kept.isEmpty() || !f.headBone || !f.neckBone || !f.alive()) return;
  // his skin tone, from his own face, so his arms and legs match it: the cheeks and chin on the
  // front of the bust, keeping the brighter half so hair, beard and shadow don't darken it
  const base = Math.max(kept.min.y, cut), tall = kept.max.y - base, midZ = (kept.min.z + kept.max.z) / 2;
  const tone = new THREE.Color(), samples = [];
  for (const m of meshes) {
    const pos = m.geometry.attributes.position, col = m.geometry.attributes.color;
    if (!col) continue;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const down = (kept.max.y - v.y) / tall;
      if (down < 0.35 || down > 0.62 || v.z < midZ) continue;
      samples.push([col.getX(i), col.getY(i), col.getZ(i)]);
    }
  }
  samples.sort((p, q) => (q[0] + q[1] + q[2]) - (p[0] + p[1] + p[2]));
  const bright = samples.slice(0, Math.max(1, Math.floor(samples.length / 2)));
  const count = samples.length ? bright.length : 0;
  if (count) tone.setRGB(...[0, 1, 2].map((k) => bright.reduce((t, p) => t + p[k], 0) / count));
  // the body's head, from the crown down to the base of the neck, as posed right now
  f.root.updateMatrixWorld(true);
  const headAt = f.headBone.getWorldPosition(new THREE.Vector3());
  const neckAt = f.neckBone.getWorldPosition(new THREE.Vector3());
  const up = headAt.clone().sub(neckAt).normalize();
  const crown = headAt.clone().addScaledVector(up, f.headAbove);
  const span = crown.distanceTo(neckAt);
  // stand the trimmed bust on that span: crown to crown, facing the way he faces
  const top = new THREE.Vector3((kept.min.x + kept.max.x) / 2, kept.max.y, (kept.min.z + kept.max.z) / 2);
  bust.position.sub(top);
  const holder = new THREE.Group();
  holder.add(bust);
  // a touch over the span: the bust's neck tucks into the collar
  holder.scale.setScalar((span * 1.14) / (kept.max.y - base));
  // turn it to face his way, then tip it to the lean of his neck
  holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up).multiply(f.root.getWorldQuaternion(new THREE.Quaternion()));
  holder.position.copy(crown);
  f.root.parent.add(holder);
  holder.updateMatrixWorld(true);
  f.headBone.attach(holder);
  // hide his own head under the face
  for (const { o, plan } of f.skins) {
    if (plan.noHead) o.geometry.setIndex(plan.noHead);
    if (count) o.material = new THREE.MeshLambertMaterial({ color: tone });
  }
  f.bust = holder;
}

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
export function mountStage({ canvas, labels, section, teams, onSelect, onView, avoid, faces }) {
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
    skin: new THREE.MeshLambertMaterial({ color: grey(0.55) }),
    shoe: cloth(grey(0.18)),
    ring: new THREE.MeshBasicMaterial({ color: grey(0.05) }),
    ball: new THREE.MeshLambertMaterial({ color: grey(0.1) }), // inked dark so it reads against the floor and the kits
  };
  // home and away: light kit for the underpriced side, dark kit for the overpriced side
  const kits = {
    under: { ...base, jersey: cloth(grey(0.86)), shorts: cloth(grey(0.7)), ink: '#111', number: new THREE.MeshBasicMaterial({ color: grey(0.04) }) },
    over: { ...base, jersey: cloth(grey(0.2)), shorts: cloth(grey(0.14)), ink: '#f4f4f4', number: new THREE.MeshBasicMaterial({ color: grey(0.97) }) },
  };

  const all = [teams.under || [], teams.over || []];
  const maxFp = Math.max(...all.flat().map((p) => p.fpg), 1);
  const figures = [];
  const hitMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  for (const [side, list] of [['under', teams.under || []], ['over', teams.over || []]]) {
    const dir = side === 'under' ? 1 : -1;
    list.forEach((pl, i) => {
      const [dx, dz] = SPOTS[pl.slot] || [6, (i - 2) * 2.5];
      const x = dir * (HOOP_X - dx), z = dir * dz;
      const metres = (pl.height || 79) * 0.0254;
      // the holder is what turns and gets picked; the body goes inside once the model has loaded
      const holder = new THREE.Group();
      holder.position.set(x, 0, z);
      holder.rotation.set(0, Math.atan2(dir * HOOP_X - x, -z), 0); // facing the hoop, as a pure turn so it can be steered
      scene.add(holder);
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, metres + 0.3, 8), hitMat);
      hit.position.y = (metres + 0.3) / 2;
      holder.add(hit);
      const r = 0.45 + 0.75 * (pl.fpg / maxFp);
      const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 0.05, 64), base.ring);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.006, z);
      scene.add(ring);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `col-label ${side === 'under' ? 'up' : 'down'}`;
      el.innerHTML = '<b></b><span></span>';
      el.querySelector('b').textContent = `${pl.name}${pl.jersey ? ` #${pl.jersey}` : ''}`;
      el.querySelector('span').textContent = `${pl.slot} · ${pl.fpg.toFixed(1)} proj · ${side === 'under' ? 'under' : 'over'}priced ${Math.abs(pl.gap).toFixed(1)}`;
      el.title = SLOT_NAMES[pl.slot] || '';
      labels.append(el);
      const pose = POSES_BY_SLOT[pl.slot] || 'set';
      // the point guard starts with the ball
      const f = { pl, side, root: holder, ring, el, face: holder.rotation.y, pose, stance: pl.slot === 'PG' ? 'dribble' : 'ready', metres, head: new THREE.Vector3(x, metres + 0.45, z) };
      holder.traverse((o) => { o.userData.figure = f; });
      el.onclick = () => select(f);
      el.onmouseenter = () => { hovered = f; };
      el.onmouseleave = () => { if (hovered === f) hovered = null; };
      figures.push(f);
    });
  }

  // bodies: a rigged human model per player, posed by bone; capsule figures if it cannot load
  let alive = true;
  let dressed = null;
  const putFace = (f) => {
    if (!dressed || f.bust || f.facing || !faces?.has(f.pl.id)) return;
    f.facing = true;
    attachFace(f, faces.url(f.pl.id), dressed.GLTFLoader).catch(() => {}).finally(() => { f.facing = false; });
  };
  loadBody().then((body) => {
    if (!alive) return;
    for (const f of figures) { f.alive = () => alive; dressFigure(f, body, kits[f.side], base); }
    dressed = body.real || body;
    setupBalls();
    for (const f of figures) putFace(f);
  }).catch(() => {
    if (!alive) return;
    for (const f of figures) {
      const fig = makePlayer(f.pose, f.pl.jersey, kits[f.side]);
      fig.root.scale.setScalar(f.metres / 2);
      f.root.add(fig.root);
    }
  });

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

  // ---------- the ball: one per side, starting with the point guard ----------
  // Click a teammate and whoever has the ball turns to him and throws a chest pass; he turns to
  // the passer, catches it, and starts dribbling. Everyone else on that side watches the ball.
  const balls = {};
  const ballGeo = new THREE.SphereGeometry(0.15, 20, 14); // a little over life size, to read at this distance
  function setupBalls() {
    for (const side of ['under', 'over']) {
      const team = figures.filter((f) => f.side === side && f.mixer);
      if (!team.length) continue;
      const holder = team.find((f) => f.pl.slot === 'PG') || team[0];
      for (const f of team) f.stance = f === holder ? 'dribble' : 'ready';
      const mesh = new THREE.Mesh(ballGeo, base.ball);
      mesh.castShadow = true;
      scene.add(mesh);
      balls[side] = { mesh, holder, flight: null };
    }
  }
  function passTo(f) {
    const b = balls[f.side];
    if (!b || !f.mixer || b.flight || b.holder === f) return;
    const from = b.holder;
    from.stance = 'pass'; from.look = f;
    f.stance = 'catch'; f.look = from;
    if (still) { land(b, from, f); return; }
    // a beat to turn and load up, then the ball flies, quicker over short passes
    const dist = from.root.position.distanceTo(f.root.position);
    b.flight = { from, to: f, wait: 0.32, t: 0, dur: 0.38 + dist * 0.035, start: null };
  }
  function land(b, from, to) {
    b.holder = to; b.flight = null;
    to.stance = 'dribble'; to.look = null;
    from.look = null; from.recover = still ? 0 : 0.35;
    if (still) from.stance = 'ready';
  }
  const hand = new THREE.Vector3(), hand2 = new THREE.Vector3();
  const between = (f, out) => {
    f.hands[0].getWorldPosition(out); f.hands[1].getWorldPosition(hand2);
    return out.add(hand2).multiplyScalar(0.5);
  };
  function moveBalls(dt, t) {
    for (const b of Object.values(balls)) {
      const fl = b.flight;
      if (fl) {
        if (fl.wait > 0) { fl.wait -= dt; between(fl.from, b.mesh.position); b.mesh.position.y += 0.05; continue; }
        fl.start ||= b.mesh.position.clone();
        fl.t = Math.min(1, fl.t + dt / fl.dur);
        between(fl.to, hand);
        const u = fl.t;
        b.mesh.position.lerpVectors(fl.start, hand, u);
        b.mesh.position.y += Math.sin(Math.PI * u) * (0.25 + fl.dur * 0.35);
        b.mesh.rotation.x += dt * 9;
        if (u >= 1) land(b, fl.from, fl.to);
        continue;
      }
      const h = b.holder;
      if (!h?.hands?.[1]) continue;
      // dribbling with the right hand, out in front of him
      h.hands[1].getWorldPosition(hand);
      const bounce = Math.abs(Math.sin(t * 5.2));
      b.mesh.position.set(hand.x, 0.15 + bounce * Math.max(0, hand.y - 0.27), hand.z);
    }
  }
  // which way each player turns: toward his pass while one is on, the ball handler toward the
  // hoop (or toward you once you have picked him), everyone else toward the ball
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const yawTo = (f, x, z) => Math.atan2(x - f.root.position.x, z - f.root.position.z);
  function turnPlayers(dt) {
    for (const f of figures) {
      if (!f.mixer) continue;
      if (f.recover > 0 && (f.recover -= dt) <= 0) f.stance = 'ready';
      const b = balls[f.side];
      const hoopX = (f.side === 'under' ? 1 : -1) * HOOP_X;
      let target;
      if (f.look) target = yawTo(f, f.look.root.position.x, f.look.root.position.z);
      else if (f === selected) target = yawTo(f, camera.position.x, camera.position.z);
      else if (!b || b.holder === f) target = yawTo(f, hoopX, 0);
      else target = yawTo(f, b.holder.root.position.x, b.holder.root.position.z);
      const k = still ? 1 : 1 - Math.exp(-dt * 7);
      f.root.rotation.y += wrapAngle(target - f.root.rotation.y) * k;
    }
  }

  // ---------- selection ----------
  let selected = null, hovered = null;
  function select(f) {
    if (selected) {
      gsap.killTweensOf(selected.ring.scale);
      selected.ring.scale.set(1, 1, 1);
    }
    selected = f === selected ? null : f;
    if (selected) {
      // the ball goes to him, he turns to face you once he has it, and his ring pulses
      passTo(selected);
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
    const dt = Math.min(0.05, (now - (frame.last || now)) / 1000); frame.last = now;
    turnPlayers(dt);
    for (const f of figures) animateFigure(f, still ? 0 : dt, still);
    moveBalls(still ? 0 : dt, (now - t0) / 1000);
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
    // a face that has just been made: set it on its player
    showFaces: () => { for (const f of figures) putFace(f); },
    destroy() {
      cancelAnimationFrame(raf);
      alive = false;
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
