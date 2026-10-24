from PIL import Image
import sys, glob

BG = (11, 13, 18)

def analyze(path):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    diffcount = 0
    for y in range(0, h, 3):
        for x in range(0, w, 3):
            r, g, b = px[x, y]
            if abs(r - BG[0]) + abs(g - BG[1]) + abs(b - BG[2]) > 26:
                diffcount += 1
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    return w, h, (minx, miny, maxx, maxy), diffcount

for p in sorted(sys.argv[1:]):
    w, h, bb, n = analyze(p)
    flags = []
    if n < 200:
        flags.append("BLANK")
    if bb[0] < 18 or bb[1] < 18 or bb[2] > w - 18 or bb[3] > h - 18:
        flags.append("TOUCHES_EDGE")
    print("%-16s %dx%d bbox=%s ink=%d %s" % (p.split('/')[-1], w, h, bb, n, " ".join(flags)))
