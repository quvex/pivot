#!/bin/sh
# Sets up the local face generator (TripoSR) in .faces/, which git ignores.
# Needs Python 3.10 or newer and about 4 GB of disk (PyTorch plus the 1.7 GB model, which downloads
# on the first face). Run with: npm run faces:setup
set -e
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else "Python 3.10 or newer is needed")'

mkdir -p .faces
if [ ! -d .faces/TripoSR ]; then
  git clone -q https://github.com/VAST-AI-Research/TripoSR.git .faces/TripoSR
  git -C .faces/TripoSR checkout -q 107cefdc244c39106fa830359024f6a2f1c78871
fi
[ -x .faces/venv/bin/python ] || "$PY" -m venv .faces/venv
.faces/venv/bin/pip install -q --upgrade pip
# transformers stays on 4.x: 5.x renamed the image encoder's layers and TripoSR's weights no longer load
.faces/venv/bin/pip install -q torch numpy omegaconf Pillow einops "transformers>=4.40,<5" trimesh huggingface-hub PyMCubes

# TripoSR's marching cubes needs a compiled CUDA/C++ extension; use PyMCubes instead
.faces/venv/bin/python - <<'EOF'
p = '.faces/TripoSR/tsr/models/isosurface.py'
s = open(p).read()
old = "from torchmcubes import marching_cubes\n"
if old in s:
    s = s.replace(old, (
        "import mcubes\n\n\n"
        "def marching_cubes(level, threshold):\n"
        "    # PyMCubes instead of torchmcubes; returned in torchmcubes' axis order\n"
        "    v, f = mcubes.marching_cubes(level.cpu().numpy(), threshold)\n"
        "    return torch.from_numpy(v.astype(np.float32)[..., [2, 1, 0]].copy()), torch.from_numpy(f.astype(np.int64))\n"
    ))
    open(p, 'w').write(s)
EOF
echo "Face generator ready. Start Pivot (npm start) and use 'Make 3D faces' on the home court."
