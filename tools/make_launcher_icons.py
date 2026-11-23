"""Generate Android launcher icons (mipmap-*) for the Grocery app.
Reuses the cart glyph from make_icons.py, rendered as a rounded green
square with a white cart, sized per density bucket.
Run: python tools/make_launcher_icons.py
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
RES = os.path.join(ROOT, "android", "res")

# Android launcher icon sizes per density bucket.
DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

BRAND = (46, 125, 50)
INK = (255, 255, 255)


def png(path, w, h, pixels):
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def inside_rounded_square(nx, ny, radius):
    """Fill test for a rounded square in unit coords."""
    cx = min(max(nx, radius), 1.0 - radius)
    cy = min(max(ny, radius), 1.0 - radius)
    dx = nx - cx
    dy = ny - cy
    return dx * dx + dy * dy <= radius * radius


def in_cart(nx, ny):
    """Cart glyph, unit coords. Scaled/centered by caller."""
    # Handle: diagonal bar from upper-left down to the basket rim.
    if 0.10 <= ny <= 0.34:
        t = (nx - 0.10) / (0.40 - 0.10)
        if -0.08 <= t <= 1.15:
            line_y = 0.10 + (0.34 - 0.10) * max(0.0, min(1.0, t))
            if abs(ny - line_y) <= 0.05:
                return True
    # Basket: trapezoid, wide at bottom.
    if 0.32 <= ny <= 0.70:
        t = (ny - 0.32) / 0.38
        half = 0.15 + 0.11 * t
        if abs(nx - 0.55) <= half:
            return True
    # Wheels.
    for wx, wy in ((0.40, 0.84), (0.72, 0.84)):
        if (nx - wx) ** 2 + (ny - wy) ** 2 <= 0.050 ** 2:
            return True
    return False


def draw(size):
    """Transparent corners, rounded-square green badge, white cart centered."""
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    radius = 0.22  # rounded corner radius in unit coords
    # Glyph occupies the central 62% so it reads well at small sizes.
    pad = 0.19
    for y in range(size):
        ny = (y + 0.5) / size
        for x in range(size):
            nx = (x + 0.5) / size
            if not inside_rounded_square(nx, ny, radius):
                continue
            gx = (nx - 0.5) / (1.0 - 2 * pad) + 0.5
            gy = (ny - 0.5) / (1.0 - 2 * pad) + 0.5
            px[y][x] = (INK + (255,)) if (0.0 <= gx <= 1.0 and 0.0 <= gy <= 1.0
                                          and in_cart(gx, gy)) else (BRAND + (255,))
    return px


def main():
    for bucket, size in DENSITIES.items():
        outdir = os.path.join(RES, "mipmap-" + bucket)
        os.makedirs(outdir, exist_ok=True)
        path = os.path.join(outdir, "ic_launcher.png")
        png(path, size, size, draw(size))
        print("wrote", os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()