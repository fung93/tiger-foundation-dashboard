"""Builds the metallic cyberpunk tiger head as one SVG. The left half is drawn by hand and
mirrored, so the head is exactly symmetric. Writes <out>/tiger.svg."""
import sys
out = sys.argv[1]
mx = lambda p: (512 - p[0], p[1])
def pts(ps): return ' '.join('%g,%g' % p for p in ps)
def both(ps, fill, extra=''):
    a = '<polygon points="%s" fill="%s"%s/>' % (pts(ps), fill, extra)
    b = '<polygon points="%s" fill="%s"%s/>' % (pts([mx(p) for p in ps]), fill, extra)
    return a + b
def one(ps, fill, extra=''):
    return '<polygon points="%s" fill="%s"%s/>' % (pts(ps), fill, extra)

# the head's outline, left half, top centre round to the chin
L = [(256,112),(206,116),(172,128),(140,160),(104,190),(88,222),(62,262),(44,316),(88,326),(70,368),(118,398),(170,430),(222,446),(256,448)]
outline = L + [mx(p) for p in reversed(L[1:-1])]

# facets (left half; mirrored): lighter on top, darker to the sides and under the jaw
F = [
  ([(256,112),(206,116),(172,128),(150,196),(256,186)], 'url(#chromeHi)'),     # forehead
  ([(172,128),(140,160),(104,190),(150,196)], 'url(#chromeMid)'),              # temple
  ([(150,196),(256,186),(256,228),(198,232)], 'url(#chromeMid)'),              # brow
  ([(104,190),(88,222),(62,262),(166,292),(198,232),(150,196)], 'url(#chromeSide)'),  # cheek
  ([(198,232),(256,228),(256,298),(214,326),(166,292)], 'url(#chromeHi)'),     # muzzle
  ([(62,262),(44,316),(88,326),(70,368),(118,398),(166,292)], 'url(#chromeDark)'),   # ruff
  ([(166,292),(214,326),(256,338),(256,396),(176,404),(118,398)], 'url(#chromeMid)'),# lower muzzle
  ([(118,398),(176,404),(256,396),(256,448),(222,446),(170,430)], 'url(#chromeDark)'),   # chin
]
STRIPE = '#0a0d12'
S = [
  [(256,122),(246,140),(256,172),(266,140)],                   # centre forehead (centre line: draw once)
  [(210,124),(194,134),(236,168),(222,140)],                   # forehead chevron
  [(176,140),(164,156),(208,184),(190,160)],                   # second forehead chevron
  [(94,206),(156,224),(100,232)],                              # temple stripe
  [(70,256),(160,270),(82,280)],                               # cheek stripe
  [(56,300),(150,302),(66,314)],                               # lower cheek stripe
  [(96,344),(148,340),(104,360)],                              # ruff stripe
]
EAR = [(96,206),(84,146),(104,104),(140,92),(178,122),(164,162)]
ears = both(EAR, 'url(#chromeMid)') + both([(106,170),(100,140),(116,114),(142,106),(162,128),(150,150)], '#1a1f27')

parts = []
parts.append(ears)
parts.append(''.join(both(ps, f) for ps, f in F))
parts.append(one(S[0], STRIPE) + ''.join(both(s, STRIPE) for s in S[1:]))
# the facet edges: a fine dark line between the planes
edges = ''.join(both(ps, 'none', ' stroke="#0b0e13" stroke-width="2" stroke-linejoin="round" opacity=".55"') for ps, f in F)
parts.append(edges)
# the white brow patch over each eye
parts.append(both([(168,228),(204,212),(240,226),(204,234)], '#ffffff', ' opacity=".85"'))
# eyes: angular, slanting up to the outside, glowing cyan with a white-hot core
eye = [(164,252),(200,232),(236,246),(206,262)]
core = [(178,250),(200,240),(222,247),(204,255)]
parts.append('<g filter="url(#glow)">' + both(eye, '#21e6ff') + '</g>' + both(core, '#e9fdff'))
# nose and mouth
nose = [(220,290),(292,290),(280,316),(256,332),(232,316)]
parts.append(one(nose, '#14181f') + one([(226,292),(286,292),(280,300),(232,300)], '#5d6673'))
parts.append('<path d="M256 332v16M256 348l-28 14M256 348l28 14" stroke="#0b0e13" stroke-width="7" stroke-linecap="round" fill="none"/>')
# whisker dots
parts.append(''.join('<circle cx="%g" cy="%g" r="3.6" fill="#0b0e13"/><circle cx="%g" cy="%g" r="3.6" fill="#0b0e13"/>' % (x, y, 512 - x, y)
  for x, y in [(212,346),(198,356),(220,360)]))
# specular streaks: down the forehead, across each cheek plane, down the nose bridge
parts.append('<polygon points="236,128 248,128 238,190 226,190" fill="#fff" opacity=".55"/>')
parts.append(both([(110,214),(124,210),(176,268),(166,274)], '#ffffff', ' opacity=".35"'))
parts.append(one([(250,236),(262,236),(262,284),(250,284)], '#ffffff', ' opacity=".5"'))

svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs>
  <radialGradient id="bg" cx="50%%" cy="42%%" r="70%%"><stop offset="0" stop-color="#141a24"/><stop offset="1" stop-color="#05070b"/></radialGradient>
  <linearGradient id="chromeHi" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#dfe4ea"/><stop offset="1" stop-color="#f7f9fb"/></linearGradient>
  <linearGradient id="chromeMid" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e3e8ee"/><stop offset=".5" stop-color="#a7b0bc"/><stop offset="1" stop-color="#d4dae1"/></linearGradient>
  <linearGradient id="chromeSide" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bcc4ce"/><stop offset=".6" stop-color="#7d8794"/><stop offset="1" stop-color="#aab3be"/></linearGradient>
  <linearGradient id="chromeDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8d96a2"/><stop offset="1" stop-color="#4a525d"/></linearGradient>
  <filter id="glow" x="-50%%" y="-50%%" width="200%%" height="200%%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="soft" x="-20%%" y="-20%%" width="140%%" height="140%%"><feGaussianBlur stdDeviation="5"/></filter>
</defs>
<rect width="512" height="512" rx="112" fill="url(#bg)"/>
<g id="tiger">
  <!-- the split neon edge: magenta to one side, cyan to the other, behind the chrome -->
  <g fill="#ff2bd1" opacity=".75" transform="translate(7 3)" filter="url(#soft)"><polygon points="%(o)s"/>%(earsil)s</g>
  <g fill="#21e6ff" opacity=".75" transform="translate(-7 -3)" filter="url(#soft)"><polygon points="%(o)s"/>%(earsil)s</g>
  %(ears)s
  <polygon points="%(o)s" fill="#cfd5dd"/>
  %(rest)s
</g>
</svg>''' % {'o': pts(outline), 'earsil': '<polygon points="%s"/><polygon points="%s"/>' % (pts(EAR), pts([mx(q) for q in EAR])), 'ears': parts[0], 'rest': ''.join(parts[1:])}
open(out + '/tiger.svg', 'w', encoding='utf-8').write(svg)
print('wrote', len(svg), 'bytes')
