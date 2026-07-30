import ctypes
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageGrab


def best_match(screen, template):
    screen = np.asarray(screen.convert("L"), dtype=np.float32)
    template = np.asarray(template.convert("L"), dtype=np.float32)
    height, width = template.shape
    sh, sw = screen.shape
    if height > sh or width > sw:
        return 0.0
    # Native confirmation dialogs are centered. Sample a deterministic grid of
    # pixels and scan only the center region to avoid interacting with anything
    # else on the desktop.
    ys = np.linspace(4, height - 5, 28, dtype=int)
    xs = np.linspace(4, width - 5, 40, dtype=int)
    sample = template[np.ix_(ys, xs)].ravel()
    sample = (sample - sample.mean()) / max(1.0, sample.std())
    cx, cy = sw // 2, sh // 2
    x0, x1 = max(0, cx - width // 2 - 260), min(sw - width, cx - width // 2 + 260)
    y0, y1 = max(0, cy - height // 2 - 180), min(sh - height, cy - height // 2 + 180)
    best = 0.0
    for top in range(y0, y1 + 1, 4):
        for left in range(x0, x1 + 1, 4):
            candidate = screen[top + ys[:, None], left + xs].ravel()
            std = candidate.std()
            if std < 1:
                continue
            candidate = (candidate - candidate.mean()) / std
            best = max(best, float(np.mean(sample * candidate)))
    return best


template_path, result_path = map(Path, sys.argv[1:3])
template = Image.open(template_path)
deadline = time.monotonic() + 10
result = "not-found"
while time.monotonic() < deadline:
    score = best_match(ImageGrab.grab(all_screens=True), template)
    if score >= 0.78:
        user32 = ctypes.windll.user32
        user32.keybd_event(0x0D, 0, 0, 0)
        user32.keybd_event(0x0D, 0, 2, 0)
        result = f"confirmed:{score:.3f}"
        break
    time.sleep(0.15)
result_path.write_text(result, encoding="utf-8")
