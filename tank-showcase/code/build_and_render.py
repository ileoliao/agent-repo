"""
Procedural modern-MBT (ZTZ-99A-style) scale-model showcase.
Builds the whole scene in Blender (geometry, materials, lights, 7 shot cameras)
and renders 720 frames (30 s @ 24 fps).

Usage:
  blender -b -P build_and_render.py -- [--test 36,120,...] [--res 1280x720]
          [--samples 24] [--engine CYCLES|EEVEE] [--out DIR] [--save scene.blend]
Without --test it renders the full animation into --out as PNG frames
(existing frames are skipped, so the render can be resumed).
"""
import bpy, bmesh, math, sys, os, random
from mathutils import Vector, Matrix, Euler

# ----------------------------------------------------------------------------- args
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def arg(name, default=None):
    if name in argv:
        i = argv.index(name)
        return argv[i + 1] if i + 1 < len(argv) else True
    return default
TEST = arg("--test")
RES = arg("--res", "960x540")
SAMPLES = int(arg("--samples", "12"))
ENGINE = arg("--engine", "CYCLES")
OUT = arg("--out", "/workspace/tank_video/frames")
SAVE = arg("--save")
RX, RY = [int(v) for v in RES.split("x")]
random.seed(7)
rad = math.radians

# ----------------------------------------------------------------------------- reset
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
COL = scene.collection

# ============================================================================= materials
def node_mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    return m, nt, out

def bsdf(nt, **kw):
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    for k, v in kw.items():
        if k in b.inputs:
            b.inputs[k].default_value = v
    return b

def N(nt, typ, **props):
    n = nt.nodes.new(typ)
    for k, v in props.items():
        setattr(n, k, v)
    return n

def L(nt, a, b):
    nt.links.new(a, b)

def math_node(nt, op, a=None, b=None, clamp=False):
    n = N(nt, "ShaderNodeMath", operation=op)
    n.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            L(nt, v, n.inputs[i])
    return n.outputs[0]

def map_range(nt, src, fmin, fmax, tmin=0.0, tmax=1.0):
    n = N(nt, "ShaderNodeMapRange")
    n.clamp = True
    L(nt, src, n.inputs["Value"])
    n.inputs["From Min"].default_value = fmin
    n.inputs["From Max"].default_value = fmax
    n.inputs["To Min"].default_value = tmin
    n.inputs["To Max"].default_value = tmax
    return n.outputs[0]

def noise(nt, vec, scale, detail=4.0, rough=0.55, dist=0.0):
    n = N(nt, "ShaderNodeTexNoise")
    if vec is not None:
        L(nt, vec, n.inputs["Vector"])
    n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = detail
    n.inputs["Roughness"].default_value = rough
    n.inputs["Distortion"].default_value = dist
    return n

def mix_col(nt, fac, a, b):
    n = N(nt, "ShaderNodeMix", data_type="RGBA", blend_type="MIX")
    L(nt, fac, n.inputs["Factor"]) if not isinstance(fac, float) else None
    if isinstance(fac, float):
        n.inputs["Factor"].default_value = fac
    for sock, v in ((n.inputs[6], a), (n.inputs[7], b)):
        if isinstance(v, tuple):
            sock.default_value = v
        else:
            L(nt, v, sock)
    return n.outputs[2]

def mix_val(nt, fac, a, b):
    n = N(nt, "ShaderNodeMix", data_type="FLOAT")
    L(nt, fac, n.inputs["Factor"])
    for sock, v in ((n.inputs[2], a), (n.inputs[3], b)):
        if isinstance(v, (int, float)):
            sock.default_value = v
        else:
            L(nt, v, sock)
    return n.outputs[0]

def weathered(name, base_cols, camo=True, dirt_height=0.9, metal_edge=True,
              rough=0.62, pixel=7.0, streaks=False):
    """Painted armour: digital camo + chipped edges + scratches + dust + streaks."""
    m, nt, out = node_mat(name)
    geo = N(nt, "ShaderNodeNewGeometry")
    pos = geo.outputs["Position"]
    # --- digital camo: snap world position to a pixel grid, then low-freq noise
    if camo:
        # tri-planar pixel camo: drop the dominant-normal axis so pixel edges stay
        # straight on sloped plates (like a real painted pattern)
        an = N(nt, "ShaderNodeVectorMath", operation="ABSOLUTE")
        L(nt, geo.outputs["True Normal"], an.inputs[0])
        sxyz = N(nt, "ShaderNodeSeparateXYZ"); L(nt, an.outputs[0], sxyz.inputs[0])
        nx, ny, nz = sxyz.outputs[0], sxyz.outputs[1], sxyz.outputs[2]
        wx = math_node(nt, "MULTIPLY", math_node(nt, "GREATER_THAN", nx, ny), math_node(nt, "GREATER_THAN", nx, nz))
        wy = math_node(nt, "MULTIPLY", math_node(nt, "GREATER_THAN", ny, nx), math_node(nt, "GREATER_THAN", ny, nz))
        def proj(mask):
            vm = N(nt, "ShaderNodeVectorMath", operation="MULTIPLY")
            L(nt, pos, vm.inputs[0]); vm.inputs[1].default_value = mask
            sc_ = N(nt, "ShaderNodeVectorMath", operation="SCALE")
            L(nt, vm.outputs[0], sc_.inputs[0]); sc_.inputs["Scale"].default_value = pixel
            fl = N(nt, "ShaderNodeVectorMath", operation="FLOOR"); L(nt, sc_.outputs[0], fl.inputs[0])
            return fl.outputs[0]
        def pick(vx, vy, vz):
            m1 = N(nt, "ShaderNodeMix", data_type="VECTOR"); L(nt, wy, m1.inputs["Factor"])
            L(nt, vz, m1.inputs[4]); L(nt, vy, m1.inputs[5])
            m2 = N(nt, "ShaderNodeMix", data_type="VECTOR"); L(nt, wx, m2.inputs["Factor"])
            L(nt, m1.outputs[1], m2.inputs[4]); L(nt, vx, m2.inputs[5])
            return m2.outputs[1]
        snapped = pick(proj((0, 1, 1)), proj((1, 0, 1)), proj((1, 1, 0)))
        class _S: pass
        sn = _S(); sn.outputs = [snapped]
        n1 = noise(nt, sn.outputs[0], 0.16, 2.0, 0.5)
        n2 = noise(nt, sn.outputs[0], 0.33, 1.0, 0.5)
        r1 = N(nt, "ShaderNodeValToRGB")
        cr = r1.color_ramp; cr.interpolation = "CONSTANT"
        cr.elements[0].position = 0.0; cr.elements[0].color = base_cols[0]
        cr.elements[1].position = 0.47; cr.elements[1].color = base_cols[1]
        e = cr.elements.new(0.56); e.color = base_cols[2]
        L(nt, n1.outputs["Fac"], r1.inputs["Fac"])
        m2 = map_range(nt, n2.outputs["Fac"], 0.58, 0.585)
        col = mix_col(nt, m2, r1.outputs["Color"], base_cols[3])
    else:
        col = None
    # --- macro paint variation
    nv = noise(nt, pos, 3.0, 6.0, 0.6)
    var = map_range(nt, nv.outputs["Fac"], 0.3, 0.7, -0.06, 0.06)
    if col is None:
        col = N(nt, "ShaderNodeRGB").outputs[0]
        col.node.outputs[0].default_value = base_cols[0]
    hsv = N(nt, "ShaderNodeHueSaturation")
    L(nt, col, hsv.inputs["Color"])
    L(nt, math_node(nt, "ADD", var, 1.0), hsv.inputs["Value"])
    paint = hsv.outputs[0]
    # --- rain streaks / grime (vertically stretched noise)
    if streaks:
        st = N(nt, "ShaderNodeVectorMath", operation="MULTIPLY")
        L(nt, pos, st.inputs[0]); st.inputs[1].default_value = (14.0, 14.0, 0.8)
        ns = noise(nt, st.outputs[0], 2.0, 3.0, 0.6)
        smask = map_range(nt, ns.outputs["Fac"], 0.55, 0.75, 0.0, 0.35)
        paint = mix_col(nt, smask, paint, (0.03, 0.028, 0.022, 1))
    # --- dust / mud from below
    sep = N(nt, "ShaderNodeSeparateXYZ"); L(nt, pos, sep.inputs[0])
    hmask = map_range(nt, sep.outputs["Z"], 0.05, dirt_height, 1.0, 0.0)
    nd = noise(nt, pos, 9.0, 8.0, 0.65, 0.3)
    dn = map_range(nt, nd.outputs["Fac"], 0.35, 0.65)
    dirt = math_node(nt, "MULTIPLY", hmask, dn)
    dirt = math_node(nt, "MULTIPLY", dirt, 1.3, clamp=True)
    paint = mix_col(nt, dirt, paint, (0.21, 0.17, 0.12, 1))
    # --- edge wear: compare bevelled normal against true normal (Cycles)
    bev = N(nt, "ShaderNodeBevel"); bev.samples = 4
    bev.inputs["Radius"].default_value = 0.012
    dot = N(nt, "ShaderNodeVectorMath", operation="DOT_PRODUCT")
    L(nt, bev.outputs[0], dot.inputs[0]); L(nt, geo.outputs["True Normal"], dot.inputs[1])
    edge = map_range(nt, dot.outputs["Value"], 0.99, 0.9)
    ne = noise(nt, pos, 28.0, 10.0, 0.7)
    edge_brk = map_range(nt, ne.outputs["Fac"], 0.42, 0.62)
    wear = math_node(nt, "MULTIPLY", edge, edge_brk)
    wear = map_range(nt, wear, 0.45, 0.7)
    # --- fine scratches (anisotropic noise lines)
    sv = N(nt, "ShaderNodeVectorMath", operation="MULTIPLY")
    L(nt, pos, sv.inputs[0]); sv.inputs[1].default_value = (90.0, 6.0, 30.0)
    nsc = noise(nt, sv.outputs[0], 1.0, 2.0, 0.5)
    scr = map_range(nt, nsc.outputs["Fac"], 0.73, 0.75)
    nsm = noise(nt, pos, 4.0, 2.0, 0.5)
    scr = math_node(nt, "MULTIPLY", scr, map_range(nt, nsm.outputs["Fac"], 0.5, 0.6))
    wear = math_node(nt, "MAXIMUM", wear, scr)
    metal = (0.30, 0.29, 0.27, 1)
    base = mix_col(nt, wear, paint, metal) if metal_edge else paint
    b = bsdf(nt)
    L(nt, base, b.inputs["Base Color"])
    L(nt, mix_val(nt, wear, 0.0, 0.9 if metal_edge else 0.0), b.inputs["Metallic"])
    nr = noise(nt, pos, 6.0, 4.0, 0.6)
    r_paint = map_range(nt, nr.outputs["Fac"], 0.3, 0.7, rough - 0.12, rough + 0.12)
    r_paint = mix_val(nt, dirt, r_paint, 0.9)
    L(nt, mix_val(nt, wear, r_paint, 0.32), b.inputs["Roughness"])
    # bump: fine surface + chipped paint depth
    bump = N(nt, "ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.18
    bump.inputs["Distance"].default_value = 0.002
    nb = noise(nt, pos, 60.0, 6.0, 0.6)
    L(nt, math_node(nt, "SUBTRACT", nb.outputs["Fac"], math_node(nt, "MULTIPLY", wear, 0.5)),
      bump.inputs["Height"])
    L(nt, bump.outputs[0], b.inputs["Normal"])
    L(nt, b.outputs[0], out.inputs[0])
    return m

def simple(name, col, metal=0.0, rough=0.5, coat=0.0, dust=0.0, extra=None):
    m, nt, out = node_mat(name)
    b = bsdf(nt, **{"Base Color": col, "Metallic": metal, "Roughness": rough,
                    "Coat Weight": coat})
    if extra:
        for k, v in extra.items():
            if k in b.inputs:
                b.inputs[k].default_value = v
    if dust > 0:
        geo = N(nt, "ShaderNodeNewGeometry")
        nd = noise(nt, geo.outputs["Position"], 14.0, 8.0, 0.65)
        dm = map_range(nt, nd.outputs["Fac"], 0.4, 0.7, 0.0, dust)
        L(nt, mix_col(nt, dm, col, (0.2, 0.16, 0.11, 1)), b.inputs["Base Color"])
        L(nt, mix_val(nt, dm, rough, 0.95), b.inputs["Roughness"])
        if metal > 0:
            L(nt, mix_val(nt, dm, metal, 0.0), b.inputs["Metallic"])
        # polished contact edges
        bump = N(nt, "ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.08
        L(nt, noise(nt, geo.outputs["Position"], 80, 5, 0.6).outputs["Fac"], bump.inputs["Height"])
        L(nt, bump.outputs[0], b.inputs["Normal"])
    L(nt, b.outputs[0], out.inputs[0])
    return m

CAMO = [(0.055, 0.065, 0.035, 1), (0.115, 0.125, 0.075, 1), (0.21, 0.195, 0.14, 1), (0.028, 0.032, 0.026, 1)]
M_PAINT = weathered("Paint_Camo", CAMO, streaks=True)
M_PAINT_LOW = weathered("Paint_Lower", CAMO, dirt_height=1.1)
M_RUBBER = simple("Rubber", (0.015, 0.015, 0.015, 1), rough=0.75, dust=0.3)
M_STEEL = simple("TrackSteel", (0.09, 0.085, 0.08, 1), metal=0.9, rough=0.42, dust=0.75)
M_DARKMETAL = simple("DarkMetal", (0.03, 0.03, 0.032, 1), metal=0.85, rough=0.35)
M_BLACK = simple("Black", (0.002, 0.002, 0.002, 1), rough=0.9)
M_GLASS = simple("CoatedGlass", (0.004, 0.01, 0.02, 1), rough=0.02, coat=1.0,
                 extra={"Thin Film Thickness": 520.0, "Thin Film IOR": 1.38,
                        "Specular IOR Level": 0.8, "IOR": 1.6})
M_LAMPGLASS = simple("LampGlass", (0.6, 0.6, 0.55, 1), rough=0.05, extra={"Transmission Weight": 0.6})
M_CHROME = simple("Chrome", (0.8, 0.8, 0.8, 1), metal=1.0, rough=0.12)

# plinth / floor
M_PLINTH = simple("PlinthGloss", (0.004, 0.004, 0.005, 1), rough=0.06, coat=1.0,
                  extra={"Coat Roughness": 0.02})
m, nt, out = node_mat("Floor")
b = bsdf(nt, **{"Base Color": (0.006, 0.006, 0.007, 1), "Roughness": 0.22})
geo = N(nt, "ShaderNodeNewGeometry")
L(nt, map_range(nt, noise(nt, geo.outputs["Position"], 0.8, 4, 0.6).outputs["Fac"], 0.3, 0.7, 0.12, 0.35),
  b.inputs["Roughness"])
L(nt, b.outputs[0], out.inputs[0])
M_FLOOR = m

# ============================================================================= geometry helpers
class Builder:
    """Accumulates many primitives into one mesh (keeps object count low)."""
    def __init__(self, name, mats):
        self.name, self.mats, self.bm = name, mats, bmesh.new()

    def _tag(self, verts, mi):
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = mi

    def box(self, size, M=Matrix(), mi=0):
        S = Matrix.Diagonal((size[0], size[1], size[2], 1.0))
        r = bmesh.ops.create_cube(self.bm, size=1.0, matrix=M @ S)
        self._tag(r["verts"], mi)
        return r["verts"]

    def cyl(self, r1, r2, depth, M=Matrix(), segs=32, mi=0, caps=True):
        r = bmesh.ops.create_cone(self.bm, cap_ends=caps, cap_tris=False, segments=segs,
                                  radius1=r1, radius2=r2, depth=depth, matrix=M)
        self._tag(r["verts"], mi)
        return r["verts"]

    def sphere(self, rad_, M=Matrix(), mi=0, seg=8):
        r = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=max(4, seg // 2),
                                      radius=rad_, matrix=M)
        self._tag(r["verts"], mi)

    def torus(self, R, r, M=Matrix(), mi=0, seg=16, rseg=6):
        verts, rings = [], []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            ring = []
            for j in range(rseg):
                b_ = 2 * math.pi * j / rseg
                p = Vector(((R + r * math.cos(b_)) * math.cos(a), (R + r * math.cos(b_)) * math.sin(a),
                            r * math.sin(b_)))
                ring.append(self.bm.verts.new(M @ p))
            rings.append(ring)
        for i in range(seg):
            for j in range(rseg):
                f = self.bm.faces.new((rings[i][j], rings[(i + 1) % seg][j],
                                       rings[(i + 1) % seg][(j + 1) % rseg], rings[i][(j + 1) % rseg]))
                f.material_index = mi

    def loft(self, rings, mi=0):
        """rings: list of equal-length point loops; closed with caps."""
        vr = [[self.bm.verts.new(p) for p in ring] for ring in rings]
        n = len(rings[0])
        fs = [self.bm.faces.new(vr[0][::-1]), self.bm.faces.new(vr[-1])]
        for a, b_ in zip(vr[:-1], vr[1:]):
            for i in range(n):
                fs.append(self.bm.faces.new((a[i], a[(i + 1) % n], b_[(i + 1) % n], b_[i])))
        for f in fs:
            f.material_index = mi
        return fs

    def prism_xz(self, pts, y0, y1, mi=0):
        return self.loft([[Vector((x, y0, z)) for x, z in pts], [Vector((x, y1, z)) for x, z in pts]], mi)

    def build(self, bevel=0.012, seg=2, smooth_angle=35, parent=None, loc=(0, 0, 0)):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me); self.bm.free()
        for mt in self.mats:
            me.materials.append(mt)
        ob = bpy.data.objects.new(self.name, me)
        COL.objects.link(ob)
        ob.location = loc
        if parent:
            ob.parent = parent
        try:
            me.shade_smooth()
            me.set_sharp_from_angle(angle=rad(smooth_angle))
        except Exception:
            for p in me.polygons:
                p.use_smooth = True
        if bevel > 0:
            md = ob.modifiers.new("Bevel", "BEVEL")
            md.width = bevel; md.segments = seg
            md.limit_method = "ANGLE"; md.angle_limit = rad(40)
            md.harden_normals = False
            md.use_clamp_overlap = True
        return ob

def TRS(loc=(0, 0, 0), rot=(0, 0, 0), scale=1.0):
    return Matrix.LocRotScale(Vector(loc), Euler(rot), Vector((scale, scale, scale)) if isinstance(scale, (int, float)) else Vector(scale))

def basis(origin, xdir, zdir):
    z = Vector(zdir).normalized()
    x = (Vector(xdir) - z * Vector(xdir).dot(z)).normalized()
    y = z.cross(x)
    M = Matrix((x, y, z)).transposed().to_4x4()
    M.translation = Vector(origin)
    return M

X_AXIS = Euler((0, rad(90), 0))  # local Z -> world +X
Y_AXIS = Euler((rad(-90), 0, 0))  # local Z -> world +Y

def quad_point(q, u, v, center):
    """bilinear point on quad q=(p00,p10,p01,p11) + tangents & outward normal"""
    p00, p10, p01, p11 = [Vector(p) for p in q]
    bottom = p00.lerp(p10, u); top = p01.lerp(p11, u)
    p = bottom.lerp(top, v)
    du = (p10 - p00).lerp(p11 - p01, v)
    dv = top - bottom
    n = du.cross(dv).normalized()
    if n.dot(p - Vector(center)) < 0:
        n = -n
    return p, du.normalized(), dv.normalized(), n

def era_block(B, p, du, n, w, h, t, mi=0, bolts=True):
    M = basis(p + n * (t / 2), du, n)
    B.box((w, h, t), M, mi)
    # little raised lid + bolts
    B.box((w * 0.82, h * 0.7, 0.012), M @ TRS((0, 0, t / 2 + 0.006)), mi)
    if bolts:
        for sx in (-1, 1):
            for sy in (-1, 1):
                B.cyl(0.012, 0.010, 0.016, M @ TRS((sx * w * 0.42, sy * h * 0.38, t / 2 + 0.004)), 8, mi)

# ============================================================================= tank
root = bpy.data.objects.new("Tank", None); COL.objects.link(root)

# ---------------- hull
H = Builder("Hull", [M_PAINT_LOW, M_DARKMETAL, M_LAMPGLASS, M_BLACK])
hull_prof = [(-3.40, 0.50), (2.85, 0.50), (3.50, 0.98), (2.30, 1.38), (-3.30, 1.38), (-3.45, 1.20)]
H.prism_xz(hull_prof, -1.20, 1.20)
for s in (-1, 1):  # sponsons / fenders
    y0, y1 = (1.18, 1.82) if s > 0 else (-1.82, -1.18)
    H.prism_xz([(-3.50, 1.26), (3.30, 1.26), (3.62, 1.30), (3.30, 1.36), (-3.45, 1.36)], y0, y1)
# glacis ERA grid
glacis = ((3.50, -1.10, 0.98), (3.50, 1.10, 0.98), (2.30, -1.10, 1.38), (2.30, 1.10, 1.38))
for i in range(7):
    for j in range(2):
        p, du, dv, n = quad_point(glacis, (i + 0.5) / 7, 0.22 + j * 0.5, (0, 0, 0))
        era_block(H, p, du, n, 0.29, 0.52, 0.075)
# driver hatch, periscopes
H.cyl(0.30, 0.28, 0.06, TRS((1.95, 0.0, 1.41)), 32)
H.cyl(0.06, 0.06, 0.02, TRS((1.95, 0.0, 1.45)), 12)
for k in (-1, 0, 1):
    H.box((0.08, 0.16, 0.06), TRS((2.22, k * 0.2, 1.42), (0, rad(-18), 0)))
    H.box((0.01, 0.13, 0.035), TRS((2.265, k * 0.2, 1.425), (0, rad(-18), 0)), 2)
# headlights with guards
for s in (-1, 1):
    hp = Vector((3.36, s * 1.48, 1.42))
    H.cyl(0.07, 0.07, 0.10, TRS(hp, X_AXIS), 20)
    H.cyl(0.058, 0.058, 0.012, TRS(hp + Vector((0.055, 0, 0)), X_AXIS), 20, 2)
    for k in (-1, 1):
        H.box((0.18, 0.015, 0.015), TRS(hp + Vector((0.03, k * 0.09, 0.07))))
    H.box((0.015, 0.2, 0.015), TRS(hp + Vector((0.12, 0, 0.07))))
    # tow hooks
    H.torus(0.07, 0.022, TRS((3.42, s * 0.75, 0.8), (rad(90), 0, 0)), 1)
    H.box((0.12, 0.08, 0.14), TRS((3.30, s * 0.75, 0.8)), 1)
# rear engine deck grilles
for i in range(14):
    H.box((0.06, 1.9, 0.03), TRS((-3.1 + i * 0.13, 0, 1.395)))
H.box((1.9, 2.0, 0.015), TRS((-2.25, 0, 1.385)), 3)
# rear fender tool boxes
for s in (-1, 1):
    H.box((0.9, 0.5, 0.18), TRS((-2.85, s * 1.5, 1.45)))
# rear external fuel drums
for s in (-1, 1):
    M = TRS((-3.72, s * 0.62, 1.22), (rad(90), 0, 0))
    H.cyl(0.26, 0.26, 0.95, M, 32)
    for k in (-0.35, 0.0, 0.35):
        H.cyl(0.27, 0.27, 0.03, M @ TRS((0, 0, k)), 32)
    H.box((0.08, 0.98, 0.1), TRS((-3.55, s * 0.62, 0.92)), 1)
# rear lights
for s in (-1, 1):
    H.box((0.05, 0.12, 0.08), TRS((-3.47, s * 1.55, 1.3)), 1)
hull = H.build(bevel=0.012, parent=root)

# ---------------- side skirts
S = Builder("Skirts", [M_PAINT_LOW, M_DARKMETAL])
for s in (-1, 1):
    y = s * 1.86
    xs = [-3.45 + i * 0.98 for i in range(8)]
    for i in range(7):
        x0, x1 = xs[i] + 0.015, xs[i + 1] - 0.015
        S.box((x1 - x0, 0.035, 0.40), TRS(((x0 + x1) / 2, y, 1.12)))
        for k in range(4):  # bolts along top
            S.cyl(0.014, 0.012, 0.03, TRS((x0 + 0.1 + k * (x1 - x0 - 0.2) / 3, y + s * 0.02, 1.28), Y_AXIS if s > 0 else Euler((rad(90), 0, 0))), 8, 1)
        if i >= 4:  # ERA skirt boxes up front
            for k in range(3):
                for j in range(2):
                    p = Vector((x0 + 0.16 + k * 0.32, y + s * 0.0175, 1.03 + j * 0.19))
                    era_block(S, p, Vector((1, 0, 0)), Vector((0, s, 0)), 0.29, 0.17, 0.06)
    # front mud flap (angled)
    S.box((0.4, 0.035, 0.3), TRS((3.52, y, 1.2), (0, rad(-30), 0)))
skirts = S.build(bevel=0.008, parent=root)

# ---------------- running gear
TRACK_Y = 1.5
WHEEL_X = [-2.45, -1.5, -0.55, 0.4, 1.35, 2.3]
WHEEL_Z, WHEEL_R = 0.42, 0.36
SPROCKET = (-3.28, 0.80, 0.32)
IDLER = (3.22, 0.72, 0.30)
ROLLERS = [(-1.9, 1.06, 0.10), (0.0, 1.07, 0.10), (1.9, 1.06, 0.10)]

def wheel_into(B, cx, cz, cy, R, side):
    """double road wheel centred at (cx, cy, cz)"""
    for k in (-1, 1):
        yc = cy + k * 0.14
        M = TRS((cx, yc, cz), (rad(90), 0, 0))
        B.cyl(R, R, 0.2, M, 40, 1)                       # rubber tyre
        B.cyl(R * 0.83, R * 0.83, 0.205, M, 40, 0)        # rim
        o = side * (k * 0.105)
        B.cyl(R * 0.7, R * 0.55, 0.03, M @ TRS((0, 0, -o * 0.0 + (0.1 if k * side > 0 else -0.1) * (-1 if True else 1) * 0)), 32, 0)
    # outer dish + hub (only outer face visible)
    yo = cy + side * 0.245
    Mo = TRS((cx, yo, cz), (rad(-90) if side > 0 else rad(90), 0, 0))
    B.cyl(R * 0.72, R * 0.42, 0.04, Mo @ TRS((0, 0, -0.01)), 36, 0)
    B.cyl(0.11, 0.095, 0.04, Mo @ TRS((0, 0, 0.02)), 24, 0)
    B.cyl(0.05, 0.045, 0.02, Mo @ TRS((0, 0, 0.045)), 16, 2)
    for i in range(8):
        a = 2 * math.pi * i / 8
        B.cyl(0.011, 0.009, 0.012, Mo @ TRS((0.08 * math.cos(a), 0.08 * math.sin(a), 0.043)), 6, 2)
    for i in range(0):  # (lightening holes disabled)
        a = 2 * math.pi * i / 6 + 0.3
        B.cyl(0.04, 0.04, 0.003, Mo @ TRS((0.2 * math.cos(a) * R / 0.36, 0.2 * math.sin(a) * R / 0.36, 0.0105)), 16, 3)

def gear_into(B, cx, cz, cy, R, teeth=13):
    pts = []
    for i in range(teeth * 4):
        a = 2 * math.pi * i / (teeth * 4)
        rr = R if (i % 4) in (1, 2) else R * 0.86
        pts.append((cx + rr * math.cos(a), cz + rr * math.sin(a)))
    for k in (-1, 1):
        B.prism_xz(pts, cy + k * 0.14 - 0.05, cy + k * 0.14 + 0.05, 2)

RG = Builder("RunningGear", [M_PAINT_LOW, M_RUBBER, M_DARKMETAL, M_BLACK])
for side in (-1, 1):
    cy = side * TRACK_Y
    for x in WHEEL_X:
        wheel_into(RG, x, WHEEL_Z, cy, WHEEL_R, side)
        # suspension arm (torsion bar arm)
        RG.box((0.42, 0.1, 0.1), TRS((x + 0.2, side * 1.25, WHEEL_Z + 0.12), (0, rad(-20), 0)))
    wheel_into(RG, IDLER[0], IDLER[1], cy, IDLER[2], side)
    gear_into(RG, SPROCKET[0], SPROCKET[1], cy, SPROCKET[2])
    M = TRS((SPROCKET[0], cy, SPROCKET[1]), (rad(90), 0, 0))
    RG.cyl(0.24, 0.24, 0.36, M, 32, 0)
    RG.cyl(0.13, 0.1, 0.5, M, 24, 2)
    for x, z, r in ROLLERS:
        RG.cyl(r, r, 0.42, TRS((x, cy, z), (rad(90), 0, 0)), 24, 1)
        RG.cyl(r * 0.6, r * 0.6, 0.44, TRS((x, cy, z), (rad(90), 0, 0)), 16, 2)
running = RG.build(bevel=0.006, parent=root)

# ---------------- tracks (individual links placed along the wheel hull)
def convex_hull(pts):
    pts = sorted(set(pts))
    def cross(o, a, b): return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0: up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]   # CCW

LINK_T = 0.055
circles = [(SPROCKET[0], SPROCKET[1], SPROCKET[2] * 0.93 + LINK_T / 2),
           (IDLER[0], IDLER[1], IDLER[2] + LINK_T / 2)]
circles += [(x, WHEEL_Z, WHEEL_R + LINK_T / 2) for x in WHEEL_X]
circles += [(x, z, r + LINK_T / 2) for x, z, r in ROLLERS]
cp = []
for cx, cz, r in circles:
    for i in range(180):
        a = 2 * math.pi * i / 180
        cp.append((round(cx + r * math.cos(a), 5), round(cz + r * math.sin(a), 5)))
hullpts = convex_hull(cp)[::-1]  # clockwise in (x,z) -> left normal points outward
# resample by arc length
seglen = [math.dist(hullpts[i], hullpts[(i + 1) % len(hullpts)]) for i in range(len(hullpts))]
perim = sum(seglen)
PITCH = 0.17
NLINK = int(perim / PITCH)
PITCH = perim / NLINK

def sample(d):
    d %= perim
    for i, sl in enumerate(seglen):
        if d <= sl:
            a, b_ = hullpts[i], hullpts[(i + 1) % len(hullpts)]
            t = d / sl if sl > 0 else 0
            return (a[0] + (b_[0]-a[0])*t, a[1] + (b_[1]-a[1])*t)
        d -= sl
    return hullpts[0]

TR = Builder("Tracks", [M_STEEL, M_RUBBER])
for side in (-1, 1):
    cy = side * TRACK_Y
    for i in range(NLINK):
        d = i * PITCH
        p = sample(d); pa = sample(d - PITCH / 2); pb = sample(d + PITCH / 2)
        tx, tz = pb[0] - pa[0], pb[1] - pa[1]
        ang = math.atan2(tz, tx)
        M = TRS((p[0], cy, p[1]), (0, -ang, 0))
        # local: x along track, z outward, y across
        TR.box((0.135, 0.64, 0.03), M)                                   # shoe plate
        for k in (-1, 1):
            TR.box((0.10, 0.25, 0.022), M @ TRS((0, k * 0.17, 0.024)), 1)   # rubber pads
            TR.box((0.03, 0.26, 0.012), M @ TRS((0.045, k * 0.17, 0.019)))  # grouser
            TR.box((0.04, 0.05, 0.05), M @ TRS((0.07, k * 0.34, 0.0)))       # end connectors
        TR.box((0.04, 0.05, 0.05), M @ TRS((0.07, 0.0, -0.01)))
        TR.box((0.07, 0.06, 0.09), M @ TRS((0.0, 0.0, -0.06)))              # guide horn
        for k in (-1, 1):
            TR.cyl(0.017, 0.017, 0.70, M @ TRS((k * 0.07, 0, -0.005), (rad(90), 0, 0)), 10)  # pins
            for e in (-1, 1):
                TR.cyl(0.024, 0.024, 0.02, M @ TRS((k * 0.07, e * 0.36, -0.005), (rad(90), 0, 0)), 6)  # pin nuts
tracks = TR.build(bevel=0.004, seg=1, parent=root)

# ---------------- turret
TZ0, TZ1 = 1.46, 2.0
B_OUT = [(-2.1, -1.50), (1.0, -1.68), (2.3, -0.50), (2.3, 0.50), (1.0, 1.68), (-2.1, 1.50)]
T_OUT = [(-2.0, -1.38), (0.9, -1.54), (2.05, -0.44), (2.05, 0.44), (0.9, 1.54), (-2.0, 1.38)]
TC = (0.0, 0.0, 1.75)
T = Builder("Turret", [M_PAINT, M_DARKMETAL, M_GLASS, M_BLACK, M_CHROME])
T.cyl(1.15, 1.15, 0.1, TRS((0, 0, 1.42)), 48, 1)  # turret ring
T.loft([[Vector((x, y, TZ0)) for x, y in B_OUT], [Vector((x, y, TZ1)) for x, y in T_OUT]])
def tquad(i):
    j = (i + 1) % len(B_OUT)
    return ((*B_OUT[i], TZ0), (*B_OUT[j], TZ0), (*T_OUT[i], TZ1), (*T_OUT[j], TZ1))
# wedge ERA on front faces (two layers)
for fi in (1, 3):
    q = tquad(fi)
    for i in range(4):
        for j in range(2):
            p, du, dv, n = quad_point(q, (i + 0.5) / 4, 0.27 + j * 0.47, TC)
            era_block(T, p, du, n, 0.36, 0.24, 0.13)
            era_block(T, p + n * 0.13, du, n, 0.30, 0.20, 0.05, bolts=False)
# side faces: ERA (front part), smoke launchers, stowage boxes
for fi in (0, 4):
    q = tquad(fi)
    front_u = [0.88, 0.77, 0.66] if fi == 0 else [0.12, 0.23, 0.34]
    for u in front_u:
        for v in (0.28, 0.72):
            p, du, dv, n = quad_point(q, u, v, TC)
            era_block(T, p, du, n, 0.31, 0.24, 0.11)
    # smoke grenade launchers (2x2 tubes angled forward/up/out)
    u = 0.47 if fi == 0 else 0.53
    p, du, dv, n = quad_point(q, u, 0.55, TC)
    T.box((0.32, 0.12, 0.3), basis(p + n * 0.06, du, n), 1)
    aim = (n * 0.8 + Vector((0.4, 0, 0.6))).normalized()
    for a in (-1, 1):
        for b_ in (-1, 1):
            c = p + n * 0.16 + du * (a * 0.075) + Vector((0, 0, b_ * 0.075))
            Mt = basis(c, du, aim)
            T.cyl(0.04, 0.04, 0.26, Mt, 16, 1)
            T.cyl(0.032, 0.032, 0.265, Mt, 16, 3)
    # stowage boxes on rear half
    for u, w in ((0.70, 0.55), (0.88, 0.38)) if fi == 0 else ((0.30, 0.55), (0.12, 0.38)):
        p, du, dv, n = quad_point(q, u, 0.5, TC)
        Mb = basis(p + n * 0.11, du, n)
        T.box((w, 0.36, 0.22), Mb)
        T.box((w + 0.02, 0.06, 0.24), Mb @ TRS((0, 0.15, 0)))
        for k in (-1, 1):
            T.box((0.03, 0.30, 0.235), Mb @ TRS((k * w * 0.3, 0, 0)), 1)  # straps
# rivets along roof edge
for i in range(len(T_OUT)):
    a, b_ = Vector((*T_OUT[i], TZ1)), Vector((*T_OUT[(i + 1) % len(T_OUT)], TZ1))
    n = int((b_ - a).length / 0.16)
    for k in range(1, n):
        p = a.lerp(b_, k / n)
        p = p + (Vector((0, 0, TZ1)) - p).normalized() * 0.0 + (Vector((TC[0], TC[1], TZ1)) - p).normalized() * 0.06
        T.cyl(0.014, 0.008, 0.018, TRS((p.x, p.y, TZ1 + 0.008)), 8)
# weld seam beads along the wedge/side edges
for i in (1, 4):
    a, b_ = Vector((*B_OUT[i], TZ0)), Vector((*T_OUT[i], TZ1))
    for k in range(18):
        p = a.lerp(b_, (k + 0.5) / 18)
        T.sphere(0.017, TRS(p, scale=(1.0, 1.0, 0.7)), 0, 8)
# roof armour tiles (front-left, foreground for sight macro)
for i in range(3):
    for j in range(2):
        p = Vector((1.15 + i * 0.27, 0.35 + j * 0.42, TZ1))
        era_block(T, p, Vector((1, 0, 0)), Vector((0, 0, 1)), 0.25, 0.38, 0.05)
# commander cupola + hatch
T.cyl(0.40, 0.38, 0.12, TRS((-0.65, 0.62, TZ1 + 0.06)), 40)
T.cyl(0.34, 0.33, 0.05, TRS((-0.65, 0.62, TZ1 + 0.145)), 40)
T.box((0.12, 0.08, 0.05), TRS((-0.35, 0.62, TZ1 + 0.16)), 1)
for k in range(6):
    a = 2 * math.pi * k / 6 + 0.4
    T.box((0.09, 0.05, 0.06), TRS((-0.65 + 0.40 * math.cos(a), 0.62 + 0.40 * math.sin(a), TZ1 + 0.1), (0, 0, a)), 2)
# commander panoramic sight
CS = Vector((0.05, 1.0, TZ1))
T.cyl(0.13, 0.11, 0.24, TRS(CS + Vector((0, 0, 0.12))), 32, 1)
T.cyl(0.15, 0.15, 0.03, TRS(CS + Vector((0, 0, 0.245))), 32)
head_c = CS + Vector((0, 0, 0.40))
T.box((0.30, 0.30, 0.28), TRS(head_c))
T.box((0.34, 0.33, 0.04), TRS(head_c + Vector((0.02, 0, 0.16))))              # top lid
T.box((0.10, 0.34, 0.04), TRS(head_c + Vector((0.20, 0, 0.12)), (0, rad(25), 0)))  # sun hood
Ml = TRS(head_c + Vector((0.15, 0, -0.01)), X_AXIS)
T.cyl(0.105, 0.105, 0.03, Ml, 40, 1)               # bezel ring
T.cyl(0.095, 0.095, 0.02, Ml @ TRS((0, 0, 0.015)), 40, 4)
T.cyl(0.085, 0.085, 0.02, Ml @ TRS((0, 0, 0.02)), 40, 2)   # coated lens
for k in range(4):
    a = 2 * math.pi * k / 4 + math.pi / 4
    T.cyl(0.012, 0.012, 0.012, Ml @ TRS((0.125 * math.cos(a), 0.125 * math.sin(a), 0.0)), 8, 4)
# gunner sight (box with two windows + half-open armoured shutter)
GS = Vector((1.0, -0.95, TZ1))
T.box((0.55, 0.42, 0.30), TRS(GS + Vector((0, 0, 0.15))))
for k in (-1, 1):
    Mw = TRS(GS + Vector((0.276, k * 0.1, 0.15)), X_AXIS)
    T.cyl(0.07, 0.07, 0.02, Mw, 32, 1)
    T.cyl(0.058, 0.058, 0.022, Mw @ TRS((0, 0, 0.004)), 32, 2)
hinge = GS + Vector((0.28, 0, 0.30))
T.box((0.04, 0.44, 0.30), TRS(hinge) @ TRS((0, 0, 0), (0, rad(-65), 0)) @ TRS((0, 0, -0.15)))
T.cyl(0.02, 0.02, 0.46, TRS(hinge, (rad(90), 0, 0)), 12, 1)
# loader hatch + remote MG
T.cyl(0.34, 0.33, 0.06, TRS((-0.7, -0.6, TZ1 + 0.03)), 40)
T.cyl(0.08, 0.1, 0.25, TRS((-0.35, -0.35, TZ1 + 0.13)), 16, 1)
T.box((0.35, 0.18, 0.18), TRS((-0.30, -0.35, TZ1 + 0.32)), 1)
T.cyl(0.022, 0.022, 0.85, TRS((0.25, -0.35, TZ1 + 0.33), X_AXIS), 12, 1)
T.cyl(0.032, 0.025, 0.12, TRS((0.68, -0.35, TZ1 + 0.33), X_AXIS), 12, 1)
T.box((0.15, 0.12, 0.14), TRS((-0.35, -0.48, TZ1 + 0.3)), 1)
# laser warning receivers & wind sensor
for s in (-1, 1):
    T.box((0.14, 0.14, 0.12), TRS((0.75, s * 1.38, TZ1 + 0.06)))
    T.cyl(0.05, 0.05, 0.04, TRS((0.75, s * 1.38, TZ1 + 0.14)), 16, 2)
T.cyl(0.02, 0.02, 0.5, TRS((-1.75, 0.0, TZ1 + 0.25)), 8, 1)
T.cyl(0.05, 0.05, 0.08, TRS((-1.75, 0.0, TZ1 + 0.52)), 12, 1)
# lifting hooks
for x, y in ((0.85, 1.25), (0.85, -1.25), (-1.75, 1.15), (-1.75, -1.15)):
    T.torus(0.07, 0.016, TRS((x, y, TZ1 + 0.06), (rad(90), 0, math.atan2(y, x))), 0, 16, 6)
# antennas
for s in (-1, 1):
    T.cyl(0.05, 0.04, 0.12, TRS((-1.85, s * 1.15, TZ1 + 0.06)), 16, 1)
    T.cyl(0.03, 0.03, 0.06, TRS((-1.85, s * 1.15, TZ1 + 0.15)), 12, 1)
    T.cyl(0.009, 0.005, 2.1, TRS((-1.85, s * 1.15, TZ1 + 1.2)), 8, 1)
    T.sphere(0.012, TRS((-1.85, s * 1.15, TZ1 + 2.25)), 1, 8)
# rear bustle stowage basket frame (solid bars)
bx0, bx1, bz0, bz1, by = -2.65, -2.02, 1.58, 1.98, 1.36
for z in (bz0, bz1):
    T.box((0.03, 2 * by, 0.03), TRS((bx0, 0, z)), 1)
    for s in (-1, 1):
        T.box((bx1 - bx0, 0.03, 0.03), TRS(((bx0 + bx1) / 2, s * by, z)), 1)
for i in range(13):
    y = -by + i * (2 * by / 12)
    T.box((0.018, 0.018, bz1 - bz0), TRS((bx0, y, (bz0 + bz1) / 2)), 1)
for z in (1.68, 1.78, 1.88):
    T.box((0.015, 2 * by, 0.015), TRS((bx0, 0, z)), 1)
T.box((0.6, 2.6, 0.03), TRS(((bx0 + bx1) / 2, 0, bz0 - 0.01)), 1)
# stuff in basket (tarp roll + boxes)
T.cyl(0.13, 0.13, 1.6, TRS((-2.35, 0.25, 1.73), (rad(90), 0, 0)), 24)
T.box((0.4, 0.5, 0.25), TRS((-2.35, -0.9, 1.72)))
# gun mantlet
T.box((0.55, 0.80, 0.52), TRS((2.45, 0, 1.73)))
T.box((0.20, 0.55, 0.40), TRS((2.78, 0, 1.73)))
turret = T.build(bevel=0.012, parent=root)

# ---------------- main gun
GZ = 1.73
G = Builder("Gun", [M_PAINT, M_DARKMETAL, M_BLACK])
def gcyl(r1, r2, x0, x1, segs=40, mi=0):
    G.cyl(r1, r2, x1 - x0, TRS(((x0 + x1) / 2, 0, GZ), X_AXIS), segs, mi)
gcyl(0.21, 0.19, 2.85, 3.35)            # collar
gcyl(0.155, 0.15, 3.35, 5.3)            # thermal sleeve 1
for x in (3.6, 4.15, 4.7, 5.2):
    gcyl(0.168, 0.168, x - 0.03, x + 0.03, 40, 1)   # sleeve clamps
gcyl(0.15, 0.19, 5.3, 5.45)             # fume extractor taper in
gcyl(0.19, 0.19, 5.45, 6.05)
gcyl(0.19, 0.145, 6.05, 6.22)
gcyl(0.14, 0.135, 6.22, 8.15)           # thermal sleeve 2
for x in (6.7, 7.25, 7.8):
    gcyl(0.152, 0.152, x - 0.03, x + 0.03, 40, 1)
gcyl(0.12, 0.12, 8.15, 8.55, 40, 1)     # muzzle
gcyl(0.135, 0.135, 8.5, 8.58, 40, 1)    # muzzle crown
G.cyl(0.062, 0.062, 0.02, TRS((8.585, 0, GZ), X_AXIS), 32, 2)   # bore
G.box((0.12, 0.09, 0.08), TRS((8.36, 0, GZ + 0.16)), 1)          # muzzle reference sensor
G.cyl(0.02, 0.02, 0.08, TRS((8.36, 0, GZ + 0.1)), 8, 1)
for x in ():  # extractor bolts ring (disabled)
    for k in range(10):
        a = 2 * math.pi * k / 10
        G.cyl(0.012, 0.012, 0.02, TRS((x, 0.19 * math.cos(a), GZ + 0.19 * math.sin(a)),
                                      (0, 0, 0)) @ Matrix.Rotation(-a, 4, "X") @ TRS((0, 0, 0), Y_AXIS), 6, 1)
gun = G.build(bevel=0.004, parent=root)

# ============================================================================= studio
P = Builder("Plinth", [M_PLINTH])
P.box((9.4, 5.6, 0.30), TRS((0.4, 0, -0.15)))
plinth = P.build(bevel=0.03, seg=3)
F = Builder("Floor", [M_FLOOR])
F.box((120, 120, 0.02), TRS((0, 0, -0.31)))
floor_ = F.build(bevel=0)

world = bpy.data.worlds.new("World"); scene.world = world
world.use_nodes = True
wnt = world.node_tree
for n in list(wnt.nodes):
    wnt.nodes.remove(n)
wout = wnt.nodes.new("ShaderNodeOutputWorld")
bg = wnt.nodes.new("ShaderNodeBackground")
tc = wnt.nodes.new("ShaderNodeTexCoord")
sep = wnt.nodes.new("ShaderNodeSeparateXYZ"); wnt.links.new(tc.outputs["Generated"], sep.inputs[0])
grad = map_range(wnt, sep.outputs["Z"], -0.05, 0.45, 1.0, 0.0)
wcol = mix_col(wnt, grad, (0.004, 0.005, 0.007, 1), (0.03, 0.036, 0.045, 1))
wnt.links.new(wcol, bg.inputs["Color"])
wnt.links.new(bg.outputs[0], wout.inputs[0])
WORLD_STRENGTH = bg.inputs["Strength"]

# ----------------------------------------------------------------------------- lights
def kelvin(k):
    return {3200: (1.0, 0.70, 0.42), 4500: (1.0, 0.86, 0.72), 5600: (1.0, 0.95, 0.9),
            8000: (0.72, 0.85, 1.0), 9000: (0.62, 0.8, 1.0)}[k]

LIGHTS = {}
def area(name, size, col, shape="RECTANGLE", spread=180):
    ld = bpy.data.lights.new(name, "AREA")
    ld.shape = shape
    ld.size = size[0]; ld.size_y = size[1] if len(size) > 1 else size[0]
    ld.color = col; ld.energy = 0.0
    ld.spread = rad(spread)
    ob = bpy.data.objects.new(name, ld); COL.objects.link(ob)
    aim = bpy.data.objects.new(name + "_aim", None); COL.objects.link(aim)
    c = ob.constraints.new("TRACK_TO"); c.target = aim
    c.track_axis = "TRACK_NEGATIVE_Z"; c.up_axis = "UP_Y"
    LIGHTS[name] = (ob, aim)
    return ob

def point(name, col, radius=0.05):
    ld = bpy.data.lights.new(name, "POINT"); ld.color = col; ld.energy = 0.0
    ld.shadow_soft_size = radius
    ob = bpy.data.objects.new(name, ld); COL.objects.link(ob)
    aim = bpy.data.objects.new(name + "_aim", None); COL.objects.link(aim)
    LIGHTS[name] = (ob, aim)
    return ob

area("key", (2.5, 2.5), kelvin(3200))
area("top", (7.0, 3.0), kelvin(5600))
area("rimL", (0.6, 6.0), kelvin(9000))
area("rimR", (0.6, 6.0), kelvin(9000))
area("kick", (1.5, 4.0), kelvin(8000))
area("sweep", (0.05, 5.0), kelvin(4500), spread=12)
area("graze", (0.4, 2.5), kelvin(4500), spread=60)
point("teal", (0.3, 0.9, 1.0), 0.03)
point("spec", (1.0, 0.95, 0.9), 0.02)
point("spec2", (1.0, 0.85, 0.7), 0.015)
point("spec3", (0.8, 0.9, 1.0), 0.015)
area("bgglow", (10.0, 4.0), kelvin(8000))

def key_light(name, frame, energy=None, loc=None, aim=None, interp="CONSTANT"):
    ob, am = LIGHTS[name]
    if energy is not None:
        ob.data.energy = energy
        ob.data.keyframe_insert("energy", frame=frame)
    if loc is not None:
        ob.location = loc; ob.keyframe_insert("location", frame=frame)
    if aim is not None:
        am.location = aim; am.keyframe_insert("location", frame=frame)
    for idb in (ob.data, ob, am):
        ad = idb.animation_data
        if ad and ad.action:
            for fc in ad.action.fcurves:
                for kp in fc.keyframe_points:
                    if abs(kp.co[0] - frame) < 0.01:
                        kp.interpolation = interp

# ----------------------------------------------------------------------------- shots
FPS = 24
SHOTS = [3, 4, 4, 5, 5, 5, 4]
starts = [1]
for d in SHOTS[:-1]:
    starts.append(starts[-1] + d * FPS)
ends = [s + d * FPS - 1 for s, d in zip(starts, SHOTS)]
scene.frame_start, scene.frame_end = 1, ends[-1]
scene.render.fps = FPS

def make_cam(i, lens, fstop):
    cd = bpy.data.cameras.new(f"Cam{i+1}")
    cd.lens = lens; cd.sensor_width = 36
    cd.dof.use_dof = True; cd.dof.aperture_fstop = fstop; cd.dof.aperture_blades = 7
    cd.clip_start = 0.02; cd.clip_end = 200
    cam = bpy.data.objects.new(f"Cam{i+1}", cd); COL.objects.link(cam)
    tgt = bpy.data.objects.new(f"Cam{i+1}_target", None); COL.objects.link(tgt)
    foc = bpy.data.objects.new(f"Cam{i+1}_focus", None); COL.objects.link(foc)
    c = cam.constraints.new("TRACK_TO"); c.target = tgt
    c.track_axis = "TRACK_NEGATIVE_Z"; c.up_axis = "UP_Y"
    cd.dof.focus_object = foc
    m = scene.timeline_markers.new(f"S{i+1}", frame=starts[i]); m.camera = cam
    return cam, tgt, foc

def path(obj, frames_pts, interp="BEZIER"):
    for f, p in frames_pts:
        obj.location = p; obj.keyframe_insert("location", frame=f)
    if obj.animation_data:
        for fc in obj.animation_data.action.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = interp

def ease(t):
    return t * t * (3 - 2 * t)

all_light_names = list(LIGHTS.keys())
def lights_for_shot(i, cfg):
    """cfg: name -> (energy, loc, aim). Unlisted lights are off."""
    f = starts[i]
    for nm in all_light_names:
        if nm in cfg:
            e, lc, am = cfg[nm]
            key_light(nm, f, e, lc, am)
        else:
            key_light(nm, f, 0.0)

def world_key(f, v, interp="CONSTANT"):
    WORLD_STRENGTH.default_value = v
    WORLD_STRENGTH.keyframe_insert("default_value", frame=f)
    for fc in wnt.animation_data.action.fcurves:
        for kp in fc.keyframe_points:
            if abs(kp.co[0] - f) < 0.01:
                kp.interpolation = interp

# ---- Shot 1: light sweep over the turret wedge edge (extreme close-up, push-in)
cam, tgt, foc = make_cam(0, 85, 2.0)
s, e = starts[0], ends[0]
path(cam, [(s, (3.55, 2.55, 2.30)), (e, (3.25, 2.25, 2.22))])
path(tgt, [(s, (1.55, 1.25, 1.88)), (e, (1.55, 1.25, 1.90))])
path(foc, [(s, (1.75, 1.30, 1.95)), (e, (1.75, 1.30, 1.95))])
lights_for_shot(0, {"sweep": (190, (0.4, 3.2, 3.3), (0.6, 1.3, 1.8)),
                    "rimR": (25, (-2.5, -2.0, 3.5), (0.5, 0.5, 1.8))})
key_light("sweep", s, None, (3.6, 3.0, 3.3), (2.6, 1.0, 1.8), "LINEAR")
key_light("sweep", e, None, (0.0, 3.2, 3.3), (0.0, 1.3, 1.8), "LINEAR")
world_key(s, 0.0)

# ---- Shot 2: track macro, lateral dolly rear -> front
cam, tgt, foc = make_cam(1, 50, 2.8)
s, e = starts[1], ends[1]
path(cam, [(s, (-3.4, 3.25, 0.62)), (e, (0.6, 3.25, 0.66))], "LINEAR")
path(tgt, [(s, (-2.4, 1.8, 0.22)), (e, (1.6, 1.8, 0.24))], "LINEAR")
path(foc, [(s, (-2.6, 1.95, 0.25)), (e, (1.4, 1.95, 0.27))], "LINEAR")
lights_for_shot(1, {"graze": (650, (5.5, 2.6, 1.0), (0.0, 1.85, 0.4)),
                    "rimL": (180, (-1.0, -1.0, 4.0), (0.0, 1.9, 0.5)),
                    "top": (120, (0.0, 2.0, 5.5), (0.0, 1.8, 0.3)),
                    "kick": (60, (-6.0, 3.0, 0.8), (0, 1.8, 0.4))})
world_key(s, 1.0)

# ---- Shot 3: turret side tilt up (ERA, rivets, welds, stowage)
cam, tgt, foc = make_cam(2, 55, 2.8)
s, e = starts[2], ends[2]
path(cam, [(s, (1.8, 3.9, 1.25)), (e, (1.6, 3.8, 1.75))])
path(tgt, [(s, (0.65, 1.7, 1.30)), (e, (0.4, 1.6, 2.15))])
path(foc, [(s, (0.7, 1.75, 1.55)), (e, (0.6, 1.70, 1.85))])
lights_for_shot(2, {"key": (650, (2.2, 3.4, 4.6), (0.4, 1.4, 1.7)),
                    "rimL": (380, (-2.8, 2.6, 2.6), (0.5, 1.4, 1.8)),
                    "rimR": (200, (3.2, -1.0, 3.2), (0.5, 1.4, 1.8)),
                    "top": (40, (0.0, 0.0, 5.5), (0.0, 0.0, 1.0))})

# ---- Shot 4: commander sight macro, push-in + rack focus (roof tile -> lens)
cam, tgt, foc = make_cam(3, 85, 1.8)
s, e = starts[3], ends[3]
lens_p = Vector((0.24, 1.0, 2.39))
path(cam, [(s, (2.45, 0.62, 2.36)), (e, (1.62, 0.78, 2.37))])
path(tgt, [(s, (0.1, 1.0, 2.36)), (e, (0.15, 1.0, 2.37))])
path(foc, [(s, (1.55, 0.65, 2.08)), (s + 40, (1.55, 0.65, 2.08)), (s + 80, tuple(lens_p)), (e, tuple(lens_p))])
lights_for_shot(3, {"teal": (40, (1.25, 1.30, 2.55), None),
                    "spec": (25, (1.15, 1.45, 2.30), None),
                    "spec2": (15, (1.30, 1.25, 2.42), None),
                    "spec3": (15, (1.10, 1.40, 2.48), None),
                    "key": (260, (1.5, -1.5, 4.0), (0.0, 1.0, 2.3)),
                    "rimL": (220, (-1.5, 2.5, 3.0), (0.0, 1.0, 2.3)),
                    "kick": (90, (-1.0, -1.5, 2.6), (0.0, 1.0, 2.3))})

# ---- Shot 5: low angle from muzzle pulling back along the barrel with an arc
cam, tgt, foc = make_cam(4, 28, 4.0)
s, e = starts[4], ends[4]
pts_c, pts_t, pts_f = [], [], []
for k in range(6):
    t = k / 5; te = ease(t)
    x = 9.3 - 4.6 * te
    ang = rad(30 + 25 * te)
    r = 0.9 + 0.7 * te
    pts_c.append((s + round(t * (e - s)), (x, r * math.sin(ang) + 0.05, 1.35 + 0.05 * te)))
    pts_t.append((s + round(t * (e - s)), (6.0 - 4.0 * te, 0.0, 1.72 + 0.05 * te)))
    pts_f.append((s + round(t * (e - s)), (8.45 - 4.5 * te, 0.0, 1.73)))
path(cam, pts_c, "LINEAR"); path(tgt, pts_t, "LINEAR"); path(foc, pts_f, "LINEAR")
lights_for_shot(4, {"top": (450, (5.5, 0.0, 5.0), (5.5, 0.0, 1.7)),
                    "rimL": (420, (4.0, 3.5, 3.0), (5.0, 0.0, 1.7)),
                    "rimR": (380, (4.0, -3.5, 3.0), (5.0, 0.0, 1.7)),
                    "kick": (150, (10.5, 1.5, 2.0), (2.5, 0.0, 1.8)),
                    "bgglow": (60, (-8.0, 0.0, 4.0), (-14.0, 0, 0))})
world_key(starts[4], 1.0)

# ---- Shot 6: hero 180 deg orbit, studio lights switch on one by one
cam, tgt, foc = make_cam(5, 40, 5.6)
s, e = starts[5], ends[5]
C = Vector((1.6, 0.0, 1.0))
pc, pt = [], []
for k in range(0, (e - s) + 1, 4):
    t = k / (e - s); te = ease(t)
    a = rad(35 + 180 * te)
    R = 13.5 - 1.0 * math.sin(math.pi * t)
    pc.append((s + k, (C.x + R * math.cos(a), C.y + R * math.sin(a), 3.4 + 0.4 * math.sin(math.pi * t))))
    pt.append((s + k, tuple(C)))
pc.append((e, pc[-1][1])); pt.append((e, tuple(C)))
path(cam, pc, "LINEAR"); path(tgt, pt, "LINEAR"); path(foc, [(s, (1.0, 0, 1.3))])
lights_for_shot(5, {"rimL": (30, (-3.0, 6.0, 4.0), (1.0, 0, 1.0)),
                    "rimR": (30, (-3.0, -6.0, 4.0), (1.0, 0, 1.0))})
seq = [("rimL", 900, 0), ("rimR", 900, 8), ("top", 1100, 16), ("key", 900, 24), ("kick", 300, 32), ("bgglow", 120, 40)]
place = {"top": ((1.0, 0.0, 6.5), (1.0, 0.0, 0.5)), "key": ((6.0, 5.5, 5.5), (1.0, 0, 1.0)),
         "kick": ((-6.0, 0.0, 2.5), (1.0, 0, 1.0)), "bgglow": ((0.0, 0.0, 9.0), (0, 0, 0))}
for nm, en, df in seq:
    lc, am = place.get(nm, (None, None))
    if lc:
        key_light(nm, s, None, lc, am)
    key_light(nm, s + df, en)
world_key(s, 0.4); world_key(s + 40, 1.5)

# ---- Shot 7: side profile pull-back, key fades leaving only rim, to black
cam, tgt, foc = make_cam(6, 45, 5.6)
s, e = starts[6], ends[6]
path(cam, [(s, (1.6, 11.0, 1.6)), (e, (1.6, 17.0, 1.9))])
path(tgt, [(s, (1.6, 0, 1.15)), (e, (1.6, 0, 1.2))])
path(foc, [(s, (1.6, 1.0, 1.2))])
lights_for_shot(6, {"key": (700, (4.0, 7.0, 5.0), (1.0, 0, 1.0)),
                    "top": (500, (1.0, 0.0, 6.5), (1.0, 0.0, 0.5)),
                    "rimL": (1600, (-3.0, -4.0, 6.5), (0.0, 0, 1.3)),
                    "rimR": (1600, (6.0, -4.0, 6.5), (2.5, 0, 1.3))})
key_light("key", s + 10, 700, interp="LINEAR"); key_light("key", s + 50, 0.0)
key_light("top", s + 6, 500, interp="LINEAR"); key_light("top", s + 46, 0.0)
key_light("rimL", s + 60, 1400, interp="LINEAR"); key_light("rimL", e, 250)
key_light("rimR", s + 60, 1400, interp="LINEAR"); key_light("rimR", e, 250)
world_key(s, 1.0, "LINEAR"); world_key(e, 0.0)

# ============================================================================= render settings
r = scene.render
r.resolution_x, r.resolution_y, r.resolution_percentage = RX, RY, 100
r.image_settings.file_format = "PNG"; r.image_settings.color_mode = "RGB"
r.use_overwrite = False; r.use_placeholder = True
if ENGINE == "CYCLES":
    r.engine = "CYCLES"
    cy = scene.cycles
    cy.device = "CPU"; cy.samples = SAMPLES
    cy.use_adaptive_sampling = True; cy.adaptive_threshold = 0.04
    cy.use_denoising = True; cy.denoiser = "OPENIMAGEDENOISE"
    try:
        cy.denoising_input_passes = "RGB_ALBEDO_NORMAL"
        cy.denoising_prefilter = "ACCURATE"
    except Exception:
        pass
    cy.max_bounces = 6; cy.diffuse_bounces = 2; cy.glossy_bounces = 3
    cy.transmission_bounces = 2; cy.transparent_max_bounces = 4
    cy.caustics_reflective = False; cy.caustics_refractive = False
    cy.blur_glossy = 1.0
    cy.sample_clamp_indirect = 5.0
    r.use_persistent_data = True
else:
    r.engine = "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = SAMPLES
try:
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
except Exception:
    pass
scene.view_settings.exposure = 0.0
r.film_transparent = False
scene.render.use_motion_blur = False

if SAVE:
    bpy.ops.wm.save_as_mainfile(filepath=SAVE)

print("SHOTS", list(zip(starts, ends)), "links/side", NLINK)
os.makedirs(OUT, exist_ok=True)
if TEST:
    for f in [int(v) for v in str(TEST).split(",")]:
        scene.frame_set(f)
        r.filepath = os.path.join(OUT, f"test_{f:04d}.png")
        r.use_overwrite = True
        bpy.ops.render.render(write_still=True)
else:
    r.filepath = os.path.join(OUT, "f_")
    bpy.ops.render.render(animation=True)
