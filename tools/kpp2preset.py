#!/usr/bin/env python3
"""
.kpp → REVOY25_PRESETS JS converter

Each file under paintoppresets/ is a PNG with a zTXt "preset" chunk
containing Krita preset XML. This script parses all 46 files and outputs
a JS file defining REVOY25_PRESETS for brush-engine.js.

Usage:
    python tools/kpp2preset.py src/Deevad_25.01/paintoppresets/ src/js/revoy25-presets.js
"""

import os, sys, struct, zlib, re, html, json
from xml.parsers.expat import ParserCreate

def get_ztxt_chunks(filepath):
    """Extract zTXt and iTXt chunks from a PNG file. Returns dict of {keyword: text}."""
    chunks = {}
    with open(filepath, 'rb') as f:
        sig = f.read(8)
        if sig[:4] != b'\x89PNG':
            print(f'    [skip] not a PNG: {filepath}')
            return chunks
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            length = struct.unpack('>I', hdr[:4])[0]
            chunk_type = hdr[4:8]
            data = f.read(length)
            crc = f.read(4)
            if len(data) < length:
                break
            if chunk_type == b'zTXt':
                null_pos = data.index(0)
                keyword = data[:null_pos].decode('latin-1')
                comp_method = data[null_pos + 1]
                compressed = data[null_pos + 2:]
                if comp_method == 0:
                    try:
                        text = zlib.decompress(compressed).decode('utf-8')
                        chunks[keyword] = text
                    except Exception as e:
                        print(f'    [warn] zlib decompress failed for {keyword}: {e}')
            elif chunk_type == b'iTXt':
                # iTXt: keyword\\0 compression-flag(1) compression-method(1) language\\0 translated\\0 text
                null1 = data.index(0)
                keyword = data[:null1].decode('latin-1')
                rest = data[null1+1:]
                if len(rest) < 2: continue
                comp_flag = rest[0]
                comp_meth = rest[1]  # must be 0
                rest = rest[2:]
                null2 = rest.index(0)
                lang = rest[:null2].decode('latin-1')
                rest = rest[null2+1:]
                null3 = rest.index(0)
                trans = rest[:null3].decode('latin-1')
                payload = rest[null3+1:]
                if comp_flag == 0:
                    text = payload.decode('utf-8')
                elif comp_flag == 1:
                    try:
                        text = zlib.decompress(payload).decode('utf-8')
                    except:
                        try:
                            text = zlib.decompress(payload, -zlib.MAX_WBITS).decode('utf-8')
                        except Exception as e:
                            print(f'    [warn] decompress failed for iTXt {keyword}: {e}')
                            continue
                else:
                    print(f'    [warn] unknown iTXt compression flag {comp_flag}')
                    continue
                chunks[keyword] = text
    return chunks


def parse_kpp_xml(xml_text):
    """Parse Krita preset XML into a flat param dict + presetAttrs using regex.

    Uses regex because expat chokes on nested XML inside CDATA sections
    (e.g., param values containing <Brush> XML).
    """
    result = {}
    preset_attrs = {}
    resources = []

    # Extract <Preset ...> attributes (paintopid, name, etc.)
    pm = re.search(r'<Preset\s+([^>]+)>', xml_text)
    if pm:
        attr_str = pm.group(1)
        for match in re.finditer(r'(\w+)\s*=\s*"([^"]*)"', attr_str):
            preset_attrs[match.group(1)] = match.group(2)

    # Extract <param> elements
    # Pattern: <param type="..." name="KEY"><![CDATA[VALUE]]></param>
    param_pattern = re.compile(
        r'<param\s+[^>]*name\s*=\s*"([^"]*)"[^>]*>'
        r'<!\[CDATA\[(.*?)\]\]>\s*</param>',
        re.DOTALL
    )
    for m in param_pattern.finditer(xml_text):
        key = m.group(1)
        val = m.group(2).strip()
        result[key] = val

    # Also handle non-CDATA params (internal type)
    param_pattern2 = re.compile(
        r'<param\s+[^>]*name\s*=\s*"([^"]*)"[^>]*>([^<]+)</param>',
        re.DOTALL
    )
    for m in param_pattern2.finditer(xml_text):
        key = m.group(1)
        if key not in result:
            val = m.group(2).strip()
            if val:
                result[key] = val

    # Extract <resource> elements (embedded brush tips)
    res_pattern = re.compile(
        r'<resource\s+([^>]+)>\s*<!\[CDATA\[(.*?)\]\]>\s*</resource>',
        re.DOTALL
    )
    for m in res_pattern.finditer(xml_text):
        attr_str = m.group(1)
        rtype = ''
        rfilename = ''
        for match in re.finditer(r'(\w+)\s*=\s*"([^"]*)"', attr_str):
            if match.group(1) == 'type':
                rtype = match.group(2)
            elif match.group(1) == 'filename':
                rfilename = match.group(2)
        data = m.group(2).strip()
        resources.append({
            'type': rtype,
            'filename': rfilename,
            'data': data
        })

    return result, preset_attrs, resources


def parse_brush_definition(xml_str):
    """Parse the <Brush> XML inside brush_definition param."""
    result = {}
    m_size = re.search(r'diameter="([^"]+)"', xml_str)
    if m_size:
        result['diameter'] = float(m_size.group(1))
    m_spacing = re.search(r'spacing="([^"]+)"', xml_str)
    if m_spacing:
        result['spacing'] = float(m_spacing.group(1))
    m_angle = re.search(r'angle="([^"]+)"', xml_str)
    if m_angle:
        result['angle'] = float(m_angle.group(1))
    m_type = re.search(r'type="([^"]+)"', xml_str)
    if m_type:
        result['brush_type'] = m_type.group(1)
    m_filename = re.search(r'filename="([^"]+)"', xml_str)
    if m_filename:
        result['filename'] = m_filename.group(1)
    m_scale = re.search(r'scale="([^"]+)"', xml_str)
    if m_scale:
        result['scale'] = float(m_scale.group(1))
    m_ratio = re.search(r'ratio="([^"]+)"', xml_str)
    if m_ratio:
        result['ratio'] = float(m_ratio.group(1))
    m_spikes = re.search(r'spikes="([^"]+)"', xml_str)
    if m_spikes:
        result['spikes'] = float(m_spikes.group(1))
    m_hfade = re.search(r'hfade="([^"]+)"', xml_str)
    if m_hfade:
        result['hfade'] = float(m_hfade.group(1))
    m_vfade = re.search(r'vfade="([^"]+)"', xml_str)
    if m_vfade:
        result['vfade'] = float(m_vfade.group(1))
    # Also try MaskGenerator sub-element
    mg = re.search(r'<MaskGenerator\s+([^>]+)>', xml_str)
    if mg:
        mg_attrs = dict(re.findall(r'(\w+)="([^"]*)"', mg.group(1)))
        result['mask_type'] = mg_attrs.get('type', 'circle')
        result['mask_ratio'] = float(mg_attrs.get('ratio', 1))
        result['mask_hfade'] = float(mg_attrs.get('hfade', 0.5))
        result['mask_vfade'] = float(mg_attrs.get('vfade', 0.5))
        result['mask_spikes'] = float(mg_attrs.get('spikes', 2))
        result['mask_diameter'] = float(mg_attrs.get('diameter', 100))
        if 'softness' in mg_attrs:
            result['mask_softness'] = float(mg_attrs.get('softness', 0))
        if 'antialiasEdges' in mg_attrs:
            result['mask_antialias'] = int(mg_attrs.get('antialiasEdges', 1))
    return result


def parse_curve(cdata_text):
    """Parse Krita curve format 't1,v1;t2,v2;...' into list of [t, v] pairs."""
    pairs = []
    for part in cdata_text.split(';'):
        part = part.strip()
        if not part or part == ';':
            continue
        if ',' in part:
            try:
                t, v = part.split(',')
                pairs.append([float(t), float(v)])
            except ValueError:
                pass
    return pairs


def safe_float(val, default=0.0):
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def krita_to_engine(kpp, preset_attrs, resources):
    """
    Convert Krita preset params to brush-engine.js preset object.
    Mirrors _kritaParamsToEngine() in brush-engine.js.
    """
    eng = {}

    paintopid = preset_attrs.get('paintopid', 'paintbrush')

    # ── Only paintbrush is fully supported ──
    if paintopid != 'paintbrush':
        eng['_paintopid'] = paintopid
        eng['_unsupported'] = True
        return eng

    # ── PaintOpAction ──
    # 1=buildUp(default), 2=wash(eraserMode), 3=erase
    paint_action = safe_float(kpp.get('PaintOpAction', '1'))
    eraser_mode = kpp.get('EraserMode', 'false').lower() == 'true'

    if eraser_mode or paint_action == 3:
        eng['_eraserMode'] = True

    # ── Brush definition ──
    brush_def_xml = kpp.get('brush_definition', '<Brush/>')
    brush = parse_brush_definition(brush_def_xml)

    # Size / Diameter
    size_val = brush.get('diameter', brush.get('mask_diameter', 100))
    eng['startSize'] = round(max(1, min(200, size_val)))
    eng['endSize'] = round(max(1, min(200, size_val * 0.8)))

    # Spacing
    spacing = brush.get('spacing', 0.2)
    spacing_val = kpp.get('SpacingValue', '1')
    eng['spacing'] = round(max(1, min(200, spacing * 100 * safe_float(spacing_val))))

    # Spacing sensor curve
    spacing_curve_raw = kpp.get('SpacingSensor', '')
    spacing_pressure = kpp.get('PressureSpacing', 'false').lower() == 'true'
    spacing_use_curve = kpp.get('SpacingUseCurve', 'false').lower() == 'true'
    spacing_common_curve = parse_curve(kpp.get('SpacingcommonCurve', ''))
    if spacing_pressure and spacing_use_curve and len(spacing_common_curve) >= 2:
        eng['_spacingLUT'] = spacing_common_curve

    # Angle
    angle = brush.get('angle', 0)
    eng['angle'] = round(angle % 360)

    # ── Shape ──
    brush_type = brush.get('brush_type', 'auto_brush')
    mask_type = brush.get('mask_type', 'circle')
    spikes = brush.get('mask_spikes', 2)

    # Determine procedural shape
    if brush_type == 'gbr_brush' or brush_type == 'gih_brush':
        # Uses a custom tip file (PNG/GIH/GBR)
        tip_filename = brush.get('filename', '')
        ratio = brush.get('mask_ratio', 1)
        if tip_filename:
            eng['shape'] = 'custom'
            eng['_tipUrl'] = 'brush-packs/revoy-2025/tips/' + tip_filename
            # Determine native shape fallback
            if ratio and ratio > 1.5:
                eng['_nativeShape'] = 'slash'
            elif mask_type == 'circle':
                eng['_nativeShape'] = 'circle'
            elif mask_type == 'rect':
                eng['_nativeShape'] = 'square'
            else:
                eng['_nativeShape'] = 'circle'
        else:
            eng['shape'] = 'circle'
    elif mask_type == 'circle' and spikes >= 4:
        eng['shape'] = 'circle'  # multi-spike still renders as circle with scatter
    elif mask_type == 'rect':
        eng['shape'] = 'square'
    elif mask_type == 'ellipse':
        ratio = brush.get('ratio', brush.get('mask_ratio', 1))
        if ratio and ratio > 1.5:
            eng['shape'] = 'slash'
        else:
            eng['shape'] = 'circle'
    else:
        eng['shape'] = 'circle'

    # Mask ratio → aspect ratio equivalent (not directly exposed in brush-engine)
    mask_ratio = brush.get('mask_ratio', 1)
    if mask_ratio and mask_ratio > 1.05:
        eng['_maskRatio'] = round(mask_ratio, 2)

    # ── Opacity ──
    opacity_val = safe_float(kpp.get('OpacityValue', '1'))
    eng['opacity'] = round(max(0, min(100, opacity_val * 100)))

    # Opacity sensor curve
    pressure_opacity = kpp.get('PressureOpacity', 'false').lower() == 'true'
    opacity_use_curve = kpp.get('OpacityUseCurve', 'false').lower() == 'true'
    opacity_common = parse_curve(kpp.get('OpacitycommonCurve', ''))
    if pressure_opacity and opacity_use_curve and len(opacity_common) >= 2:
        eng['_opacityLUT'] = opacity_common

    # ── Flow ──
    flow_val = safe_float(kpp.get('FlowValue', '1'))
    eng['flow'] = round(max(0, min(100, flow_val * 100)))

    # Flow sensor curve
    pressure_flow = kpp.get('PressureFlow', 'false').lower() == 'true'
    flow_use_curve = kpp.get('FlowUseCurve', 'false').lower() == 'true'
    flow_common = parse_curve(kpp.get('FlowcommonCurve', ''))
    if pressure_flow and flow_use_curve and len(flow_common) >= 2:
        eng['_flowLUT'] = flow_common

    # ── Hardness (from Sharpness/softness or MaskGenerator) ──
    softness = safe_float(brush.get('mask_softness', 0))
    sharp_softness = safe_float(kpp.get('Sharpness/softness', str(softness)))
    hardness = max(0, min(100, round((1 - sharp_softness) * 100)))
    eng['hardness'] = hardness

    hfade = brush.get('mask_hfade', 0.5)
    vfade = brush.get('mask_vfade', 0.5)

    # ── Size sensor curve ──
    pressure_size = kpp.get('PressureSize', 'false').lower() == 'true'
    size_use_curve = kpp.get('SizeUseCurve', 'false').lower() == 'true'
    size_common = parse_curve(kpp.get('SizecommonCurve', ''))
    if pressure_size and size_use_curve and len(size_common) >= 2:
        eng['_sizeLUT'] = size_common

    # ── Taper / Start-end size ──
    # Krita fades enabled: if size has a fade curve, we approximate with endSize < startSize
    if eng['startSize'] != eng['endSize']:
        eng['taper'] = round(abs(eng['startSize'] - eng['endSize']) / max(eng['startSize'], 1) * 50)
        eng['taper'] = max(0, min(100, eng['taper']))

    # ── Scatter ──
    scatter_val = safe_float(kpp.get('ScatterValue', '0'))
    scatter_x = kpp.get('Scattering/AxisX', 'true').lower() == 'true'
    scatter_y = kpp.get('Scattering/AxisY', 'true').lower() == 'true'
    # Krita scatter is 0-1 range, brush-engine uses 0-14 count
    eng['scatter'] = round(scatter_val * 14)
    if eng['scatter'] > 14:
        eng['scatter'] = 14
    # scatterRadius in brush-engine is roughly size * scatter_val * 2
    eng['scatterRadius'] = round(max(1, eng.get('startSize', 20) * scatter_val * 1.5))
    if eng['scatterRadius'] > 50: eng['scatterRadius'] = 50
    if eng['scatterRadius'] < 1: eng['scatterRadius'] = 1

    # Scatter sensor curve
    pressure_scatter = kpp.get('PressureScatter', 'false').lower() == 'true'
    scatter_use_curve = kpp.get('ScatterUseCurve', 'false').lower() == 'true'
    scatter_common = parse_curve(kpp.get('ScattercommonCurve', ''))
    if pressure_scatter and scatter_use_curve and len(scatter_common) >= 2:
        eng['_scatterLUT'] = scatter_common

    # ── Airbrush ──
    is_airbrushing = kpp.get('PaintOpSettings/isAirbrushing', 'false').lower() == 'true'
    if is_airbrushing:
        eng['airbrushMode'] = True
    airbrush_rate = safe_float(kpp.get('PaintOpSettings/rate', '20'))
    eng['airbrushRate'] = round(max(1, min(100, airbrush_rate)))

    # ── Texture ──
    texture_strength = kpp.get('Texture/strength_value', '0')
    texture_strength_num = safe_float(texture_strength)
    eng['texture'] = round(max(0, min(100, texture_strength_num * 80)))

    texture_scale = kpp.get('Texture/scale', '1')
    eng['grainScale'] = round(max(1, min(12, safe_float(texture_scale) * 3)))

    # ── Smudge (for colorsmudge paintop) ──
    if paintopid == 'colorsmudge' or paintopid == 'smudge':
        smudge_rate = safe_float(kpp.get('SmudgeLength/smudge_rate', '0.5'))
        color_rate = safe_float(kpp.get('ColorRate/color_rate', '1'))
        eng['smudge'] = round(smudge_rate * 100)
        if eng['smudge'] > 100: eng['smudge'] = 100

    # ── Common brush settings from PaintOp ──
    paintop_size = safe_float(kpp.get('PaintOp/size', '0'))
    if paintop_size > 0:
        eng['startSize'] = round(max(1, min(200, paintop_size)))
        eng['endSize'] = round(max(1, min(200, paintop_size * 0.85)))

    # ── Bristle ──
    bristle_count_raw = kpp.get('bristle_count', '0')
    bristle_count = safe_float(bristle_count_raw)
    if bristle_count > 1:
        eng['shape'] = 'bristle'
        eng['bristleCount'] = round(max(2, min(50, bristle_count)))
        bristle_spread_raw = kpp.get('bristle_spread', '0.5')
        eng['bristleSpread'] = round(max(0, min(100, safe_float(bristle_spread_raw) * 80)))

    # ── Mirror ──
    h_mirror = kpp.get('HorizontalMirrorEnabled', 'false').lower() == 'true'
    v_mirror = kpp.get('VerticalMirrorEnabled', 'false').lower() == 'true'
    if h_mirror or v_mirror:
        eng['_mirror'] = {'h': h_mirror, 'v': v_mirror}

    # ── Rotation (drawing angle / direction) ──
    rotation_sensor_raw = kpp.get('RotationSensor', '')
    if 'drawingangle' in rotation_sensor_raw:
        # Brush-engine auto-angles when angle=0 for slash/line shapes
        if eng.get('shape') in ('slash', 'bristle', 'line'):
            eng['angle'] = 0  # Let auto-angle handle it

    # ── Embedded tip data ──
    if resources:
        eng['_embeddedResources'] = []
        for r in resources:
            eng['_embeddedResources'].append({
                'filename': r['filename'],
                'type': r['type'],
                'data_len': len(r['data'])
            })
        # Only keep non-embedded tip reference — embedded ones get extracted to files
        if brush.get('filename') and brush.get('filename') not in [r['filename'] for r in resources]:
            tip_ext = os.path.splitext(brush.get('filename', ''))[1].lower()
            if tip_ext in ('.gih', '.gbr'):
                eng['_tipUrl'] = 'brush-packs/revoy-2025/tips/' + brush['filename']
                if 'shape' not in eng:
                    eng['shape'] = 'custom'
                if '_nativeShape' not in eng:
                    eng['_nativeShape'] = 'circle'

    # ── Clean up: remove empty values that match DEFAULTS ──
    defaults = {
        'shape': 'circle', 'startSize': 8, 'endSize': 8, 'spacing': 20,
        'angle': 0, 'opacity': 100, 'flow': 100, 'hardness': 100,
        'scatter': 0, 'scatterRadius': 12, 'texture': 0, 'grainScale': 4,
        'taper': 0, 'smudge': 0,
    }
    for k, v in list(eng.items()):
        if k in defaults and v == defaults[k]:
            del eng[k]

    return eng


def sanitize_preset_name(filename):
    """Convert filename to a valid JS identifier key."""
    name = os.path.splitext(filename)[0]
    # Remove prefix like "a1) " or "c2) "
    name = re.sub(r'^[a-z]\d?\)\s*', '', name)
    # Remove " - deevad 25" suffix
    name = re.sub(r'\s*[-–]\s*deevad\s*25.*$', '', name, flags=re.IGNORECASE)
    # Also handle space-only variant
    name = re.sub(r'\s+deevad\s+25.*$', '', name, flags=re.IGNORECASE)

    # Get the category prefix
    prefix = filename[0] if re.match(r'^[a-z]\)', filename) else ''
    prefix = filename[0] if re.match(r'^[a-z]\d\)', filename) else prefix
    prefix_map = {
        'a': 'eraser', 'b': 'basic', 'c': 'pencil', 'd': 'block',
        'f': 'bristle', 'g': 'water', 'i': 'mix', 'k': 'blender',
        't': 'shapes', 'v': 'distort', 'x': 'chaotic', 'y': 'texture'
    }
    cat = prefix_map.get(prefix, 'misc')

    # Build slug
    slug = name.strip().lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return cat + '_' + slug, name.strip()


def main():
    if len(sys.argv) < 2:
        print('Usage: python kpp2preset.py <paintoppresets_dir> [output.js]')
        sys.exit(1)

    src_dir = sys.argv[1]
    out_file = sys.argv[2] if len(sys.argv) > 2 else 'revoy25-presets.js'

    files = sorted([f for f in os.listdir(src_dir) if f.endswith('.kpp')])
    print(f'Found {len(files)} .kpp files')

    presets = {}
    tip_files = {}  # filename -> base64 data
    unsupported = []

    for fname in files:
        fpath = os.path.join(src_dir, fname)
        print(f'\n=== {fname} ===')

        chunks = get_ztxt_chunks(fpath)
        if 'preset' not in chunks:
            print('    [skip] no preset chunk found')
            continue

        kpp, preset_attrs, resources = parse_kpp_xml(chunks['preset'])
        if not preset_attrs:
            print('    [skip] no preset attrs in XML')
            continue

        paintopid = preset_attrs.get('paintopid', 'unknown')
        print(f'    paintopid: {paintopid}')

        key, disp_name = sanitize_preset_name(fname)
        print(f'    key: {key}')
        print(f'    display: {disp_name}')

        eng = krita_to_engine(kpp, preset_attrs, resources)

        if eng.get('_unsupported'):
            unsupported.append(fname)
            print(f'    [unsupported] paintopid={paintopid}')
            # Register as a minimal preset anyway
            eng = {
                'name': disp_name,
                '_paintopid': paintopid,
                '_unsupported': True,
            }
            presets[key] = eng
            continue

        # Track embedded resources for extraction
        if '_embeddedResources' in eng:
            for r in eng['_embeddedResources']:
                tip_files[r['filename']] = None  # Will fill with data later
            raw_embedded = [r for r in resources if r['filename'] not in tip_files or tip_files[r['filename']] is None]
            for r in raw_embedded:
                tip_files[r['filename']] = r['data']
            del eng['_embeddedResources']

        # Remove internal-only keys before serialization
        eng = {k: v for k, v in eng.items() if not k.startswith('_') or k in ('_tipUrl', '_nativeShape', '_sizeLUT', '_opacityLUT', '_flowLUT', '_scatterLUT', '_spacingLUT', '_mirror', '_paintopid', '_eraserMode', '_maskRatio')}

        presets[key] = eng
        print(f'    params: {json.dumps(eng, default=str)[:200]}...')

    # ── Generate JS output ──
    print(f'\n{"="*60}')
    print(f'Total presets: {len(presets)}')
    print(f'Unsupported: {len(unsupported)}: {unsupported}')
    print(f'Tip files referenced: {len(tip_files)}')

    # Prettify JS values
    def val_to_js(v, indent=16):
        if isinstance(v, bool):
            return 'true' if v else 'false'
        elif isinstance(v, float):
            return str(round(v, 4))
        elif isinstance(v, int):
            return str(v)
        elif isinstance(v, list):
            if not v:
                return '[]'
            inner = ', '.join(
                ('[' + ', '.join(str(round(x, 6)) for x in pair) + ']')
                if isinstance(pair, list) else str(pair)
                for pair in v
            )
            return '[' + inner + ']'
        elif isinstance(v, dict):
            items = ', '.join(f'{k}: {val_to_js(v2, indent+4)}' for k, v2 in v.items())
            return '{' + items + '}'
        else:
            return json.dumps(v)

    lines = []
    lines.append('// REVOY25_PRESETS — 46 Deevad 25.01 brush presets (David Revoy, Jan 2025)')
    lines.append('// Auto-generated by tools/kpp2preset.py')
    lines.append('// License: CC-0')
    lines.append('')
    lines.append(';(function(app) {')
    lines.append('')
    lines.append('    const REVOY25_PRESETS = {')

    for i, (key, eng) in enumerate(presets.items()):
        prefix = os.linesep.join([''] + ['    '] * 1)
        if i > 0:
            lines.append(',')

        # Comment with display name
        disp = eng.get('name', key)
        lines.append(f'')
        lines.append(f'        /* {disp} */')

        lines.append(f"        '{key}': {{")

        keys = list(eng.keys())
        for j, pk in enumerate(keys):
            if pk == 'name':
                continue
            pv = eng[pk]
            comma = ',' if j < len(keys) - (1 if 'name' in keys else 0) - 1 else ''
            if isinstance(pv, str):
                lines.append(f"            {pk}: {json.dumps(pv)}{comma}")
            elif isinstance(pv, bool):
                lines.append(f"            {pk}: {'true' if pv else 'false'}{comma}")
            elif isinstance(pv, (int, float)):
                lines.append(f"            {pk}: {round(pv, 4) if isinstance(pv, float) else pv}{comma}")
            elif isinstance(pv, list):
                pairs_str = ', '.join(
                    f'[{round(t,6)}, {round(v,6)}]' for t, v in pv
                )
                lines.append(f"            {pk}: [{pairs_str}]{comma}")
            elif isinstance(pv, dict):
                items = ', '.join(f'{k2}: {val_to_js(v2)}' for k2, v2 in pv.items())
                lines.append(f"            {pk}: {{{items}}}{comma}")
            else:
                lines.append(f"            {pk}: {json.dumps(pv)}{comma}")
        lines.append(f'        }}')

    lines.append('')
    lines.append('    };')
    lines.append('')

    # Registration code
    lines.append('    /* Register into PRESETS via app._PRESETS */')
    lines.append('    var PRESETS = app._PRESETS;')
    lines.append('    if (PRESETS) {')
    lines.append('        Object.keys(REVOY25_PRESETS).forEach(function(key) {')
    lines.append("            PRESETS['revoy25:' + key] = REVOY25_PRESETS[key];")
    lines.append('        });')
    lines.append('    }')
    lines.append('')
    lines.append('    /* Expose public API */')
    lines.append('    app._REVOY25_PRESETS = REVOY25_PRESETS;')
    lines.append('')
    lines.append('    app.brush.listRevoy25Presets = function() {')
    lines.append('        return Object.keys(REVOY25_PRESETS);')
    lines.append('    };')
    lines.append('')
    lines.append('    app.brush.loadRevoy25Preset = function(name) {')
    lines.append("        var key = 'revoy25:' + name;")
    lines.append('        if (!PRESETS || !PRESETS[key]) {')
    lines.append('            var lower = name.toLowerCase();')
    lines.append('            var found = Object.keys(REVOY25_PRESETS).find(function(k) {')
    lines.append('                return k.toLowerCase().indexOf(lower) !== -1;')
    lines.append('            });')
    lines.append('            if (found) key = "revoy25:" + found;')
    lines.append('            else { console.warn(\'[Revoy25] Unknown preset:\', name); return false; }')
    lines.append('        }')
    lines.append('        app.brush.loadPreset(key);')
    lines.append('        return true;')
    lines.append('    };')
    lines.append('')
    lines.append('})(PaintApp);')
    lines.append('')

    with open(out_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    print(f'\nWritten to {out_file}')

    # ── Also extract embedded tip files ──
    tips_dir = os.path.join(os.path.dirname(src_dir), 'brush-packs', 'revoy-2025', 'tips')
    os.makedirs(tips_dir, exist_ok=True)

    # Collect all unique tip filenames from resources
    for fname in files:
        fpath = os.path.join(src_dir, fname)
        chunks = get_ztxt_chunks(fpath)
        if 'preset' not in chunks:
            continue
        _, _, resources = parse_kpp_xml(chunks['preset'])
        for r in resources:
            if r['data']:
                tip_fpath = os.path.join(tips_dir, r['filename'])
                if not os.path.exists(tip_fpath) and r['data']:
                    try:
                        raw = base64_decode(r['data'])
                        with open(tip_fpath, 'wb') as tf:
                            tf.write(raw)
                        print(f'  Extracted tip: {r["filename"]} ({len(raw)} bytes)')
                    except Exception as e:
                        print(f'  [warn] Could not extract {r["filename"]}: {e}')

    # Also copy tip files from brushes/ directory if they exist
    brushes_src = os.path.join(os.path.dirname(src_dir), 'brushes')
    if os.path.isdir(brushes_src):
        for tf in os.listdir(brushes_src):
            dst = os.path.join(tips_dir, tf)
            if not os.path.exists(dst):
                src = os.path.join(brushes_src, tf)
                import shutil
                shutil.copy2(src, dst)
                print(f'  Copied tip: {tf}')


def base64_decode(data):
    """Decode base64 data with padding fix."""
    import base64
    data = data.strip()
    # Add padding
    pad = 4 - len(data) % 4
    if pad != 4:
        data += '=' * pad
    return base64.b64decode(data)


if __name__ == '__main__':
    main()
