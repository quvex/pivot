"""Make 3D player faces from ESPN headshots with TripoSR, entirely on this computer.

Usage: .faces/venv/bin/python scripts/faces.py <out dir> <espn id> [<espn id> ...]

Each headshot is turned into a mesh with colours on its vertices and saved as <out dir>/<id>.glb.
One JSON line per player goes to stdout, so the server can follow along:
  {"id": 3059318, "ok": true}   or   {"id": 3059318, "ok": false, "error": "..."}

TripoSR (MIT, by Stability AI and Tripo) lives in .faces/TripoSR, set up by scripts/faces-setup.sh.
"""
import io
import json
import os
import sys
import types
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".faces", "TripoSR"))
# TripoSR's helpers import these for its demo app (background removal, videos); faces need neither
for name in ("rembg", "imageio"):
    sys.modules.setdefault(name, types.ModuleType(name))

import numpy as np  # noqa: E402
import torch  # noqa: E402
import trimesh  # noqa: E402
from PIL import Image  # noqa: E402
from tsr.system import TSR  # noqa: E402
from tsr.utils import resize_foreground, to_gradio_3d_orientation  # noqa: E402

PHOTO = "https://a.espncdn.com/i/headshots/nba/players/full/{}.png"


def say(**kw):
    print(json.dumps(kw), flush=True)


def photo(pid):
    req = urllib.request.Request(PHOTO.format(pid), headers={"User-Agent": "pivot-faces"})
    with urllib.request.urlopen(req, timeout=30) as r:
        img = Image.open(io.BytesIO(r.read())).convert("RGBA")
    # ESPN cuts its headshots out on a transparent ground: centre the player, then set him on the
    # mid grey TripoSR was trained on
    img = resize_foreground(img, 0.85)
    a = np.array(img).astype(np.float32) / 255.0
    rgb = a[:, :, :3] * a[:, :, 3:4] + (1 - a[:, :, 3:4]) * 0.5
    return Image.fromarray((rgb * 255).astype(np.uint8))


def main():
    out, ids = sys.argv[1], [int(x) for x in sys.argv[2:]]
    os.makedirs(out, exist_ok=True)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = TSR.from_pretrained("stabilityai/TripoSR", config_name="config.yaml", weight_name="model.ckpt")
    model.renderer.set_chunk_size(8192)
    model.to(device)
    for pid in ids:
        try:
            image = photo(pid)
            with torch.no_grad():
                try:
                    codes = model([image], device=device)
                except (RuntimeError, NotImplementedError):
                    # an operation the Apple GPU cannot run: do this one on the processor
                    model.to("cpu")
                    device = "cpu"
                    codes = model([image], device=device)
                mesh = model.extract_mesh(codes, True, resolution=256)[0]
            # y up, facing +z, as three.js expects
            mesh = to_gradio_3d_orientation(mesh)
            mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [0, 1, 0]))
            path = os.path.join(out, f"{pid}.glb")
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(trimesh.exchange.gltf.export_glb(trimesh.Scene(mesh), include_normals=True))
            os.replace(tmp, path)
            say(id=pid, ok=True)
        except Exception as e:  # report and carry on with the next player
            say(id=pid, ok=False, error=str(e)[:300])


if __name__ == "__main__":
    main()
