"""Minimal dependency-free PNG reader/writer + 2D diff for PDF fidelity checks."""
import struct, zlib, sys


def readpng(p):
    d = open(p, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    i, idat = 8, b''
    w = h = bd = ct = None
    while i < len(d):
        ln = struct.unpack('>I', d[i:i + 4])[0]
        typ = d[i + 4:i + 8]
        data = d[i + 8:i + 8 + ln]
        i += 12 + ln
        if typ == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', data[:10])
        elif typ == b'IDAT':
            idat += data
    raw = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ct]
    bpp = ch * (bd // 8)
    stride = w * bpp
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for _ in range(h):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out += line
        prev = line
    return w, h, bpp, bytes(out)


def writepng(path, w, h, rgb):
    raw = b''.join(b'\x00' + rgb[y * w * 3:(y + 1) * w * 3] for y in range(h))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 6))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)


def main(pa, pb, pout):
    w1, h1, b1, A = readpng(pa)
    w2, h2, b2, B = readpng(pb)
    W, H = min(w1, w2), min(h1, h2)
    print(f'A {w1}x{h1}  B {w2}x{h2}  comparing {W}x{H}')

    diffs = []
    ink_a = ink_b = 0
    out = bytearray(W * H * 3)
    for y in range(H):
        ra = y * w1 * b1
        rb = y * w2 * b2
        for x in range(W):
            pa = A[ra + x * b1 : ra + x * b1 + 3]
            pb = B[rb + x * b2 : rb + x * b2 + 3]
            va = (pa[0] * 299 + pa[1] * 587 + pa[2] * 114) // 1000   # luma
            vb = (pb[0] * 299 + pb[1] * 587 + pb[2] * 114) // 1000
            d = max(abs(pa[i] - pb[i]) for i in range(3))            # worst channel
            diffs.append(d)
            if va < 128: ink_a += 1
            if vb < 128: ink_b += 1
            o = (y * W + x) * 3
            if d > 32:
                # red where only A has ink, blue where only B has ink
                if va < vb: out[o] = 255
                else: out[o + 2] = 255
            else:
                g = 255 - (255 - min(va, vb)) // 4  # faint grey context
                out[o] = out[o + 1] = out[o + 2] = g
    writepng(pout, W, H, bytes(out))

    n = len(diffs)
    over = sum(1 for d in diffs if d > 32)
    print(f'ink pixels: A={ink_a} B={ink_b} (delta {ink_b - ink_a:+d}, {100*abs(ink_b-ink_a)/max(ink_a,1):.2f}%)')
    print(f'pixels differing >32/255 : {over} ({100*over/n:.3f}%)')
    print(f'mean abs diff            : {sum(diffs)/n:.3f}/255')
    print(f'wrote {pout}')


if __name__ == '__main__':
    main(*sys.argv[1:4])
