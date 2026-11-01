#!/usr/bin/env python3
"""Génère l'icône source du cockpit (PNG 1024², sans dépendance externe).

Motif : un réticule de visée sur fond graphite — la métaphore du poste de
pilotage. Tout est rasterisé à la main avec un antialiasing par supersampling
4×, puis compressé en PNG via zlib.
"""

import math
import struct
import zlib
from pathlib import Path

SIZE = 1024
SS = 2  # supersampling
W = SIZE * SS

BG_TOP = (16, 16, 21)
BG_BOTTOM = (28, 28, 38)
ACCENT = (124, 122, 255)
ACCENT_SOFT = (86, 200, 255)
WHITE = (245, 246, 250)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def blend(dst, src, alpha):
    return tuple(round(dst[i] + (src[i] - dst[i]) * alpha) for i in range(3))


def rounded_rect_alpha(x, y, cx, cy, half, radius):
    """Alpha d'appartenance à un carré arrondi centré."""
    dx = abs(x - cx) - (half - radius)
    dy = abs(y - cy) - (half - radius)
    dx = max(dx, 0.0)
    dy = max(dy, 0.0)
    dist = math.hypot(dx, dy)
    if abs(x - cx) > half or abs(y - cy) > half:
        return 0.0
    return 1.0 if dist <= radius else 0.0


def ring_alpha(x, y, cx, cy, radius, thickness):
    dist = math.hypot(x - cx, y - cy)
    return 1.0 if abs(dist - radius) <= thickness / 2 else 0.0


def main():
    cx = cy = W / 2
    half = W * 0.44
    radius = W * 0.115

    rows = []
    for y in range(W):
        row = bytearray()
        for x in range(W):
            inside = rounded_rect_alpha(x, y, cx, cy, half, radius)
            if inside == 0.0:
                row += bytes((0, 0, 0, 0))
                continue

            # Fond : dégradé vertical + halo diagonal discret.
            t = y / W
            color = lerp(BG_TOP, BG_BOTTOM, t)
            halo = max(0.0, 1.0 - math.hypot(x - W * 0.3, y - W * 0.25) / (W * 0.85))
            color = blend(color, ACCENT, halo * 0.13)

            # Réticule : deux anneaux concentriques.
            for r, thick, tint, alpha in (
                (W * 0.255, W * 0.022, ACCENT, 1.0),
                (W * 0.135, W * 0.030, ACCENT_SOFT, 0.9),
            ):
                if ring_alpha(x, y, cx, cy, r, thick):
                    color = blend(color, tint, alpha)

            # Croix de visée, interrompue au centre.
            arm = W * 0.345
            gap = W * 0.055
            bar = W * 0.020
            on_h = abs(y - cy) <= bar / 2 and gap <= abs(x - cx) <= arm
            on_v = abs(x - cx) <= bar / 2 and gap <= abs(y - cy) <= arm
            if on_h or on_v:
                color = blend(color, WHITE, 0.92)

            # Point central.
            if math.hypot(x - cx, y - cy) <= W * 0.032:
                color = blend(color, ACCENT, 1.0)

            row += bytes((color[0], color[1], color[2], 255))
        rows.append(bytes(row))

    # Downsample SS×SS → antialiasing.
    out = bytearray()
    for y in range(SIZE):
        out.append(0)  # filtre PNG « none »
        for x in range(SIZE):
            acc = [0, 0, 0, 0]
            for dy in range(SS):
                base = rows[y * SS + dy]
                for dx in range(SS):
                    offset = ((x * SS) + dx) * 4
                    for c in range(4):
                        acc[c] += base[offset + c]
            n = SS * SS
            out += bytes(v // n for v in acc)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(out), 9))
    png += chunk(b"IEND", b"")

    target = Path(__file__).resolve().parent.parent / "app-icon.png"
    target.write_bytes(png)
    print(f"écrit {target} ({len(png) // 1024} Ko)")


if __name__ == "__main__":
    main()
