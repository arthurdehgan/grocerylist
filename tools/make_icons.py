"""Generate PWA icons (cart glyph on brand-green) without external deps.
Writes RGBA PNGs into icons/ at 192, 512, and a 512 maskable variant.
Run: python tools/make_icons.py
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

BRAND = (46, 125, 50)      # #2e7d32
INK = (255, 255, 255)      # white glyph


def png(path, w, h, pixels):
    """pixels: list of rows, each row a list of (r,g,b,a) tuples."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    comp = zlib.compress(bytes(raw), 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", comp) + chunk(b"IEND", b""))
    print("wrote", os.path.normpath(path))


def in_round_rect(x, y, w, h, rx):
    """Signed-distance test for a rounded rectangle (filled = True)."""
    cx = min(max(x, rx), w - rx)
    cy = min(max(y, rx), h - rx)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= rx * rx


def in_cart(nx, ny):
    """Return True if normalized point (0..1) is inside the cart glyph."""
    # Basket body: trapezoid from y .30 (narrow top) to y .72 (wide bottom)
    if 0.30 <= ny <= 0.70:
        t = (ny - 0.30) / 0.40
        half = 0.34 + 0.10 * t  # widens downward
        cx = 0.50
        # shift basket slightly right to leave room for handle
        cx = 0.54
        if abs(nx - cx) <= half * 0.5:
            return True
    # Handle: diagonal bar upper-left
    # line from (0.20,0.16) to (0.40,0.34), thickness
    if 0.14 <= ny <= 0.36:
        # param along the diagonal
        t = (nx - 0.16) / (0.42 - 0.16)
        if -0.05 <= t <= 1.0:
            line_y = 0.16 + (0.34 - 0.16) * max(0.0, min(1.0, t))
            if abs(ny - line_y) <= 0.045:
                return True
    # Wheels
    for wx, wy in [(0.40, 0.82), (0.68, 0.82)]:
        if (nx - wx) ** 2 + (ny - wy) ** 2 <= 0.032 ** 2:
            return True
    return False


def draw_icon(size, maskable=False):
    if maskable:
        # Keep glyph inside the safe zone (center 80%); background fills all.
        scale_pad = 0.80
    else:
        scale_pad = 0.66
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    bg = BRAND + (255,)
    fg = INK + (255,)
    for y in range(size):
        for x in range(size):
            nx = x / size
            ny = y / size
            if maskable:
                # map glyph area into central safe zone
                gx = (nx - 0.5) / scale_pad + 0.5
                gy = (ny - 0.5) / scale_pad + 0.5
            else:
                gx = nx
                gy = ny
            px[y][x] = fg if (0 <= gx <= 1 and 0 <= gy <= 1 and in_cart(gx, gy)) else bg
    return px


sizes = [192, 512]
for s in sizes:
    png(os.path.join(OUT, f"icon-{s}.png"), s, s, draw_icon(s, maskable=False))
png(os.path.join(OUT, "icon-512-maskable.png"), 512, 512, draw_icon(512, maskable=True))
print("done")