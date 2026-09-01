#!/usr/bin/env python3
"""
Génère les aperçus de widgets exigés par l'App Store Homey.

    python3 tools/widget-previews.py

⚠️ Ces images ne doivent PAS être des captures d'écran. La règle 1.10 des App Store Guidelines
refuse la capture, refuse le texte, refuse le fond : il faut un dessin de formes simples, sur
1024×1024 transparent, en version claire et sombre. Une première soumission a été refusée pour
exactement ces deux motifs, d'où ce script — qui redessine les widgets plutôt que de les
photographier, et qui rend le résultat reproductible au lieu d'être un binaire orphelin.

Les couleurs sont celles des widgets eux-mêmes (`widgets/*/public/index.html`) : l'aperçu doit
ressembler au widget, seulement en plus abstrait.
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
# Suréchantillonnage : PIL ne lisse pas les arcs de ruban, un tracé à 4× puis une réduction
# LANCZOS donne des bords propres sans code d'anticrénelage.
SS = 4

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

THEMES = {
    'light': {
        'surface': (252, 252, 251),
        'primary': (11, 11, 11),
        'secondary': (138, 138, 142),
        'muted': (185, 184, 177),
        's1': (42, 120, 214),
        's2': (235, 104, 52),
        's3': (27, 175, 122),
        'accent': (245, 159, 0),
        'shadow': 30,
    },
    'dark': {
        'surface': (26, 26, 25),
        'primary': (255, 255, 255),
        'secondary': (152, 152, 159),
        'muted': (107, 106, 100),
        's1': (57, 135, 229),
        's2': (217, 89, 38),
        's3': (25, 158, 112),
        'accent': (240, 179, 87),
        'shadow': 90,
    },
}


def blend(fg, bg, alpha):
    """Aplati une couleur translucide sur le fond de la carte.

    Dessiner les rubans en RGBA les superposerait, et un croisement virerait au noir. Comme le
    fond est uni et connu, un mélange préalable donne des aplats francs et prévisibles.
    """
    return tuple(round(f * alpha + b * (1 - alpha)) for f, b in zip(fg, bg))


def bezier(p0, p1, p2, p3, n=72):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        a, b, c, d = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
        pts.append((
            a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
            a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
        ))
    return pts


def ribbon(draw, x0, top0, bot0, x1, top1, bot1, colour):
    """Un ruban de Sankey : deux cubiques horizontales refermées l'une sur l'autre."""
    mid = (x1 - x0) / 2
    top = bezier((x0, top0), (x0 + mid, top0), (x1 - mid, top1), (x1, top1))
    bottom = bezier((x0, bot0), (x0 + mid, bot0), (x1 - mid, bot1), (x1, bot1))
    draw.polygon(top + bottom[::-1], fill=colour)


def card(theme, ratio_w, ratio_h, fill_fraction=0.86):
    """Crée la toile transparente et y pose la carte du widget, à son vrai rapport de forme."""
    img = Image.new('RGBA', (SIZE * SS, SIZE * SS), (0, 0, 0, 0))
    if ratio_w >= ratio_h:
        w = SIZE * fill_fraction
        h = w * ratio_h / ratio_w
    else:
        h = SIZE * fill_fraction
        w = h * ratio_w / ratio_h
    x0, y0 = (SIZE - w) / 2, (SIZE - h) / 2
    radius = 16 * (w / ratio_w)

    box = [x0 * SS, y0 * SS, (x0 + w) * SS, (y0 + h) * SS]
    # Ombre portée : autorisée par le gabarit d'Athom, et seule façon de détacher une carte
    # blanche d'un fond transparent qui s'affichera lui-même sur du blanc.
    shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [box[0], box[1] + 12 * SS, box[2], box[3] + 12 * SS],
        radius=radius * SS, fill=(0, 0, 0, theme['shadow']))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14 * SS))
    img = Image.alpha_composite(img, shadow)

    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(box, radius=radius * SS, fill=theme['surface'] + (255,))
    return img, draw, x0, y0, w, h


def bar(draw, ox, oy, x, y, w, h, colour):
    draw.rounded_rectangle(
        [(ox + x) * SS, (oy + y) * SS, (ox + x + w) * SS, (oy + y + h) * SS],
        radius=min(w, h) / 2 * SS, fill=colour + (255,))


def power(theme):
    """Widget « Puissance estimée » : un nom, une grande valeur, une ligne de détail, un éclair."""
    img, draw, ox, oy, w, h = card(theme, 340, 110)

    bar(draw, ox, oy, 40, 56, 200, 18, theme['secondary'])
    bar(draw, ox, oy, 40, 106, 220, 64, theme['primary'])
    bar(draw, ox, oy, 40, 202, 380, 16, theme['secondary'])

    # L'éclair de l'icône de l'app, comme accent graphique : il n'y a pas de texte dans un aperçu,
    # donc il faut une forme pour dire « puissance ».
    src = [(146, 16), (74, 142), (118, 142), (104, 240), (182, 108), (136, 108)]
    k = 140 / 224
    bx, by = 740 - (108 * k) / 2, 142 - 70
    draw.polygon([((ox + bx + (px - 74) * k) * SS, (oy + by + (py - 16) * k) * SS)
                  for px, py in src], fill=theme['accent'] + (255,))
    return img


def sankey(theme):
    """Widget « Flux d'énergie » : une source, quatre postes, six appareils."""
    img, draw, ox, oy, w, h = card(theme, 340, 460)
    surface = theme['surface']

    top, bottom = 60.0, 820.0
    span = bottom - top
    x_src, x_mid, x_right, node = 44.0, 296.0, 562.0, 22.0

    # Ordre du haut vers le bas, le poste non mesuré en dernier : c'est la lecture du vrai widget.
    posts = [('s1', 0.30), ('s2', 0.22), ('s3', 0.20), ('muted', 0.28)]

    def stack(weights, fill, gap):
        """Empile des barres occupant `fill` de la hauteur, le tout recentré.

        Les trois colonnes n'occupent PAS la même hauteur : c'est ce décalage qui fait plier les
        rubans. À hauteurs égales ils restent droits et le diagramme se lit comme un histogramme
        empilé — la première version de cet aperçu en était là.
        """
        total = span * fill
        usable = total - gap * (len(weights) - 1)
        y = top + (span - total) / 2
        out = []
        for weight in weights:
            height = usable * weight
            out.append((y, y + height))
            y += height + gap
        return out

    mids = stack([w for _, w in posts], 0.80, 16.0)

    # Sur la barre source les tranches se touchent : une source est continue.
    srcs, y = [], top
    for _, weight in posts:
        srcs.append((y, y + span * weight))
        y += span * weight

    for (key, _), (s_top, s_bot), (m_top, m_bot) in zip(posts, srcs, mids):
        ribbon(draw, (ox + x_src + node) * SS, (oy + s_top) * SS, (oy + s_bot) * SS,
               (ox + x_mid) * SS, (oy + m_top) * SS, (oy + m_bot) * SS,
               blend(theme[key], surface, 0.42) + (255,))

    # Chaque poste se répartit sur des appareils. Deux postes se divisent en deux : sans cela on
    # ne verrait pas qu'un poste EST une somme, ce qui est tout le propos du diagramme.
    splits = [(0, 0.55), (0, 0.45), (1, 0.60), (1, 0.40), (2, 1.0), (3, 1.0)]
    rights = stack([posts[i][1] * share for i, share in splits], 0.94, 13.0)

    cursors = {i: mids[i][0] for i in range(len(mids))}
    for (post, share), (r_top, r_bot) in zip(splits, rights):
        key = posts[post][0]
        m_top = cursors[post]
        m_bot = m_top + (mids[post][1] - mids[post][0]) * share
        cursors[post] = m_bot
        ribbon(draw, (ox + x_mid + node) * SS, (oy + m_top) * SS, (oy + m_bot) * SS,
               (ox + x_right) * SS, (oy + r_top) * SS, (oy + r_bot) * SS,
               blend(theme[key], surface, 0.30) + (255,))
        bar(draw, ox, oy, x_right, r_top, node, r_bot - r_top, theme['muted'])

    bar(draw, ox, oy, x_src, top, node, span, theme['secondary'])
    for (key, _), (m_top, m_bot) in zip(posts, mids):
        bar(draw, ox, oy, x_mid, m_top, node, m_bot - m_top, theme[key])
    return img


def main():
    for widget, render in (('power', power), ('sankey', sankey)):
        for name, theme in THEMES.items():
            out = os.path.join(HERE, 'widgets', widget, f'preview-{name}.png')
            render(theme).resize((SIZE, SIZE), Image.LANCZOS).save(out)
            print(f'{out} — 1024×1024 RGBA')


if __name__ == '__main__':
    main()
