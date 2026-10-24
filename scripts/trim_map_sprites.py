#!/usr/bin/env python3
"""Keep only the sprite icons the map styles can use, repacked into small PNGs.

The MapsEV sprites came with 2326 icons (770 KB-2.4 MB per PNG) while the styles reference
about 45: every name that appears in an icon-image / *-pattern expression of styles/mapsev-*.json
and exists in the sprite. Names built from tile fields that OpenMapTiles doesn't have (maki,
shield_beta, ...) can never resolve and are not kept; a missing icon is replaced by a transparent
1x1 image at runtime (styleimagemissing in js/maps/map-engine.js).

Usage: python3 scripts/trim_map_sprites.py   (needs Pillow; run `zopflipng` afterwards for
       smaller files). Re-run after adding an icon to a style; the original full sprites are in
       git history (before this script was added).
"""
import json
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPRITES = os.path.join(ROOT, 'styles', 'sprites')
PATTERN_KEYS = [('layout', 'icon-image'), ('paint', 'fill-pattern'), ('paint', 'line-pattern'),
                ('paint', 'background-pattern'), ('paint', 'fill-extrusion-pattern')]
PACK_WIDTH_1X = 256
GAP = 1  # transparent pixel between icons so linear filtering never bleeds a neighbour in


def strings_in(value, out):
    if isinstance(value, str):
        out.add(value)
    elif isinstance(value, list):
        for item in value:
            strings_in(item, out)
    elif isinstance(value, dict):
        for item in value.values():
            strings_in(item, out)


def used_icons(style, index):
    names = set()
    for layer in style['layers']:
        for group, key in PATTERN_KEYS:
            if key in layer.get(group, {}):
                strings_in(layer[group][key], names)
    return sorted(n for n in names if n in index)


def pack(sizes, width):
    """Shelf packing, tallest first: {name: (x, y)} and the total height (1x units)."""
    pos, x, y, shelf = {}, 0, 0, 0
    for name, (w, h) in sorted(sizes.items(), key=lambda kv: (-kv[1][1], kv[0])):
        if x + w > width:
            x, y, shelf = 0, y + shelf + GAP, 0
        pos[name] = (x, y)
        x += w + GAP
        shelf = max(shelf, h)
    return pos, y + shelf


def trim(theme):
    style = json.load(open(os.path.join(ROOT, 'styles', f'mapsev-{theme}.json')))
    index_1x = json.load(open(os.path.join(SPRITES, f'mapsev-{theme}.json')))
    keep = used_icons(style, index_1x)
    sizes = {n: (index_1x[n]['width'], index_1x[n]['height']) for n in keep}
    positions, height = pack(sizes, PACK_WIDTH_1X)
    for suffix, scale in (('', 1), ('@2x', 2)):
        index = json.load(open(os.path.join(SPRITES, f'mapsev-{theme}{suffix}.json')))
        source = Image.open(os.path.join(SPRITES, f'mapsev-{theme}{suffix}.png')).convert('RGBA')
        sheet = Image.new('RGBA', (PACK_WIDTH_1X * scale, max(1, height) * scale), (0, 0, 0, 0))
        new_index = {}
        for name in keep:
            icon = index[name]
            crop = source.crop((icon['x'], icon['y'], icon['x'] + icon['width'], icon['y'] + icon['height']))
            x, y = positions[name][0] * scale, positions[name][1] * scale
            sheet.paste(crop, (x, y))
            new_index[name] = {**icon, 'x': x, 'y': y}
        sheet.save(os.path.join(SPRITES, f'mapsev-{theme}{suffix}.png'), optimize=True)
        with open(os.path.join(SPRITES, f'mapsev-{theme}{suffix}.json'), 'w') as f:
            json.dump(new_index, f, indent=1, sort_keys=True)
            f.write('\n')
        print(f'{theme}{suffix}: {len(index)} -> {len(new_index)} icons, {sheet.size[0]}x{sheet.size[1]}')


if __name__ == '__main__':
    for theme in ('day', 'night'):
        trim(theme)
