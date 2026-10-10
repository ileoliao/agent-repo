"""
Artistic 1920x1080 stills of the tank model.
Opens tank_scene.blend (never saved back), strips the video's animated lights/cameras,
adds per-shot cameras + lights, renders PNGs.

  blender -b tank_scene.blend -P render_stills.py -- [--shots 1,2] [--res 1920x1080]
          [--samples 256] [--out DIR] [--save stills_scene.blend]
"""
import bpy, math, sys, os, time
from mathutils import Vector, Euler

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def arg(n, d=None):
    return argv[argv.index(n) + 1] if n in argv else d
SHOTS = [int(s) for s in arg("--shots", "1,2,3,4,5,6").split(",")]
RX, RY = [int(v) for v in arg("--res", "1920x1080").split("x")]
SAMPLES = int(arg("--samples", "256"))
OUT = arg("--out", "/workspace/tank_video/stills")
SAVE = arg("--save")
SUFFIX = arg("--suffix", "")
rad = math.radians
scene = bpy.context.scene
COL = scene.collection

# ------------------------------------------------------------- strip video rig
for ob in list(bpy.data.objects):
    if ob.type in ("LIGHT", "CAMERA") or ob.name.endswith(("_aim", "_target", "_focus")):
        bpy.data.objects.remove(ob, do_unlink=True)
for m in list(scene.timeline_markers):
    scene.timeline_markers.remove(m)
world = scene.world
world.node_tree.animation_data_clear()
WSTR = [n for n in world.node_tree.nodes if n.type == "BACKGROUND"][0].inputs["Strength"]
scene.frame_set(1)

def K(k):
    return {3000: (1.0, 0.66, 0.38), 3200: (1.0, 0.70, 0.42), 4500: (1.0, 0.86, 0.72),
            5600: (1.0, 0.95, 0.9), 7000: (0.8, 0.88, 1.0), 9000: (0.62, 0.8, 1.0)}[k]

TEMP = []  # per-shot objects
def look(ob, target, roll=0.0):
    d = Vector(target) - ob.location
    q = d.to_track_quat("-Z", "Y")
    ob.rotation_euler = q.to_euler()
    if roll:
        ob.rotation_euler.rotate_axis("Z", rad(roll))

def light(kind, loc, aim, energy, col, size=1.0, size_y=None, shape="RECTANGLE", spread=180, radius=0.05):
    ld = bpy.data.lights.new("L", kind)
    ld.energy = energy; ld.color = col
    if kind == "AREA":
        ld.shape = shape; ld.size = size; ld.size_y = size_y or size; ld.spread = rad(spread)
    elif kind in ("POINT", "SPOT"):
        ld.shadow_soft_size = radius
    ob = bpy.data.objects.new("L", ld); COL.objects.link(ob)
    ob.location = loc
    if aim is not None:
        look(ob, aim)
    TEMP.append(ob)
    return ob

def camera(loc, target, lens, fstop=None, focus=None, roll=0.0):
    cd = bpy.data.cameras.new("StillCam")
    cd.lens = lens; cd.sensor_width = 36; cd.clip_start = 0.02; cd.clip_end = 300
    if fstop:
        cd.dof.use_dof = True; cd.dof.aperture_fstop = fstop; cd.dof.aperture_blades = 7
        cd.dof.focus_distance = (Vector(focus) - Vector(loc)).length
    cam = bpy.data.objects.new("StillCam", cd); COL.objects.link(cam)
    cam.location = loc; look(cam, target, roll)
    scene.camera = cam
    TEMP.append(cam)
    return cam

def haze_box(density, color=(0.8, 0.85, 1.0)):
    me = bpy.data.meshes.new("haze")
    import bmesh
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new("haze", me); COL.objects.link(ob)
    ob.scale = (60, 60, 14); ob.location = (0, 0, 6.7)
    m = bpy.data.materials.new("haze"); m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    v = nt.nodes.new("ShaderNodeVolumePrincipled")
    v.inputs["Density"].default_value = density
    v.inputs["Color"].default_value = (*color, 1)
    v.inputs["Anisotropy"].default_value = 0.55
    nt.links.new(v.outputs[0], out.inputs["Volume"])
    me.materials.append(m)
    TEMP.append(ob)
    return ob

def backdrop(loc, rot, size, strength, col, falloff=0.5):
    """Emissive plane with radial falloff (soft glow wall)."""
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=rot)
    ob = bpy.context.active_object; ob.scale = (size[0], size[1], 1)
    m = bpy.data.materials.new("glow"); m.use_nodes = True; nt = m.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    g = nt.nodes.new("ShaderNodeTexGradient"); g.gradient_type = "SPHERICAL"
    mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0 / falloff, 1.0 / falloff * size[0] / size[1] * 0.5, 1)
    nt.links.new(tc.outputs["Object"], mp.inputs[0]); nt.links.new(mp.outputs[0], g.inputs[0])
    pw = nt.nodes.new("ShaderNodeMath"); pw.operation = "POWER"; pw.inputs[1].default_value = 2.0
    nt.links.new(g.outputs["Fac"], pw.inputs[0])
    em = nt.nodes.new("ShaderNodeEmission"); em.inputs["Color"].default_value = (*col, 1)
    mul = nt.nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; mul.inputs[1].default_value = strength
    nt.links.new(pw.outputs[0], mul.inputs[0]); nt.links.new(mul.outputs[0], em.inputs["Strength"])
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    ob.data.materials.append(m)
    ob.visible_shadow = False
    TEMP.append(ob)
    return ob

def clear():
    for ob in TEMP:
        bpy.data.objects.remove(ob, do_unlink=True)
    TEMP.clear()

# ------------------------------------------------------------- shots
# tank: +X forward, gun along +X at z=1.73 to x=8.58; hull x -3.7..3.6, |y|<1.86, roof z=2.0
def shot1():  # low heroic 3/4 front, strong rim
    camera((12.5, 5.6, 0.3), (2.0, -0.4, 1.55), 36, 5.6, (3.4, 1.2, 1.4))
    light("AREA", (7.5, 7.5, 6.5), (1.0, 0, 1.2), 650, K(3200), 3.0)             # warm key
    light("AREA", (13.0, -3.0, 2.2), (3.0, 0, 1.2), 160, K(3200), 2.5)           # warm front fill
    light("AREA", (-6.5, 5.0, 4.5), (0.0, 0.5, 1.6), 2200, K(9000), 0.6, 7.0)     # rim L
    light("AREA", (-5.5, -6.5, 5.5), (0.0, 0, 1.6), 2200, K(9000), 0.6, 7.0)     # rim R
    light("AREA", (1.0, 0.0, 7.0), (1.0, 0.0, 0.5), 250, K(5600), 7.0, 3.0)       # top
    backdrop((-22, -10, 4), (rad(90), 0, rad(-62)), (90, 40), 0.8, K(7000), 0.3)
    WSTR.default_value = 0.05
    scene.view_settings.exposure = -0.3

def shot2():  # dramatic top-down, diagonal, hard light
    camera((3.2, -0.6, 17.5), (2.2, 0.15, 0.8), 35, None, None, roll=-32)
    light("AREA", (9.0, -8.5, 8.5), (1.0, 0, 1.0), 2600, K(3200), 1.5)           # warm key ~40deg, a bit softer
    light("AREA", (-7.0, 7.0, 4.0), (1.0, 0, 1.0), 1400, K(9000), 0.5, 6.0)       # cool rim opposite
    sky = light("AREA", (2.5, 0.0, 14.0), (2.5, 0.0, 0.0), 1300, K(7000), 40.0)    # huge soft overhead: fill + sheen on plinth/floor
    sky.visible_camera = False
    WSTR.default_value = 0.3
    scene.view_settings.exposure = 0.25

def shot3():  # side profile silhouette, backlight + haze
    camera((2.15, 19.0, 0.9), (2.15, 0, 1.45), 48, 5.6, (2.2, 0, 1.3))
    backdrop((2.0, -9.0, 3.0), (rad(90), 0, 0), (36, 14), 9.0, K(4500), 0.42)
    light("AREA", (1.5, -6.0, 6.5), (1.5, 0, 1.5), 2200, K(3000), 6.0, 1.5)      # top-back rim
    light("SPOT", (-8.0, -10.0, 4.0), (0.0, 0, 1.5), 9000, K(3000), radius=0.3)  # shaft through haze
    light("SPOT", (12.0, -10.0, 4.5), (4.0, 0, 1.5), 6000, K(4500), radius=0.3)
    for o in TEMP[-2:]:
        o.data.spot_size = rad(40); o.data.spot_blend = 0.6
    haze_box(0.012, (0.9, 0.85, 0.8))
    WSTR.default_value = 0.0
    scene.view_settings.exposure = 0.0

def shot4():  # macro road wheels + track, shallow DOF
    camera((1.95, 3.05, 0.24), (-1.4, 1.75, 0.55), 60, 1.8, (0.40, 1.78, 0.42))
    light("AREA", (5.5, 3.0, 0.7), (0.0, 1.85, 0.45), 380, K(3200), 0.4, 2.5, spread=60)  # grazing warm
    light("AREA", (-3.5, 4.5, 2.5), (0.0, 1.8, 0.5), 300, K(9000), 0.5, 4.0)       # cool back rim
    light("AREA", (0.5, 2.8, 4.5), (0.0, 1.8, 0.3), 60, K(5600), 4.0, 2.0)         # soft top
    WSTR.default_value = 0.15
    scene.view_settings.exposure = -0.4

def shot5():  # down the gun axis from the muzzle
    camera((10.6, 0.62, 2.0), (2.2, -0.08, 1.82), 40, 3.5, (8.58, 0, 1.73))
    light("AREA", (6.0, 0.0, 4.6), (6.0, 0, 1.73), 260, K(5600), 6.0, 1.2)       # top strip
    light("AREA", (5.5, 3.6, 2.6), (5.0, 0, 1.73), 600, K(9000), 0.6, 6.0)        # rim L
    light("AREA", (5.5, -3.6, 2.6), (5.0, 0, 1.73), 400, K(3200), 0.6, 6.0)       # warm rim R
    light("AREA", (2.5, 4.5, 4.5), (1.0, 0, 1.8), 160, K(3200), 2.0)             # turret key
    light("AREA", (10.0, -1.6, 2.9), (8.6, 0, 1.73), 25, K(4500), 0.6, spread=50) # muzzle crown kicker
    backdrop((-20, 0, 3), (rad(90), 0, rad(-90)), (80, 36), 0.45, K(7000), 0.25)
    WSTR.default_value = 0.02
    scene.view_settings.exposure = -0.4

def shot6():  # rear 3/4 low key
    camera((-11.0, -5.0, 0.9), (-1.0, 0.2, 1.5), 50, 4.0, (-3.7, -0.8, 1.2))
    light("SPOT", (-6.5, -6.0, 3.2), (-3.7, -0.3, 1.3), 3200, K(3000), radius=0.15)   # warm accent on drums
    TEMP[-1].data.spot_size = rad(30); TEMP[-1].data.spot_blend = 0.5
    light("AREA", (-8.0, -8.0, 5.5), (-1.5, 0, 1.2), 900, K(3200), 3.5)        # large warm key, rear-side
    light("AREA", (-12.0, -2.0, 2.5), (-2.0, 0, 1.0), 260, K(5600), 4.0)       # soft fill from camera side
    light("AREA", (5.0, 4.0, 4.5), (0.0, 0, 1.6), 2600, K(9000), 0.4, 7.0)      # cold rim far front
    light("AREA", (2.0, -6.0, 5.5), (0.0, -1.0, 1.6), 900, K(9000), 0.4, 6.0)   # cold top edge near side
    light("AREA", (-2.0, 9.0, 6.0), (-3.0, -4.0, 0.0), 250, K(7000), 6.0, 2.0)  # floor lift behind
    WSTR.default_value = 0.35
    scene.view_settings.exposure = 0.4

SHOTDEF = {1: ("01_hero_low_front", shot1), 2: ("02_top_down", shot2), 3: ("03_side_silhouette_haze", shot3),
           4: ("04_macro_road_wheels", shot4), 5: ("05_gun_axis", shot5), 6: ("06_rear_lowkey", shot6)}

# ------------------------------------------------------------- render settings
r = scene.render
r.resolution_x, r.resolution_y, r.resolution_percentage = RX, RY, 100
r.use_overwrite = True; r.use_placeholder = False
r.image_settings.file_format = "PNG"; r.image_settings.color_mode = "RGB"; r.image_settings.color_depth = "8"
cy = scene.cycles
cy.samples = SAMPLES; cy.adaptive_threshold = 0.015; cy.adaptive_min_samples = 32
cy.max_bounces = 8; cy.diffuse_bounces = 3; cy.glossy_bounces = 4
cy.volume_bounces = 0; cy.volume_step_rate = 4.0
cy.use_denoising = True
cy.film_exposure = 1.0
try:
    cy.time_limit = 480
except Exception:
    pass
os.makedirs(OUT, exist_ok=True)
for s in SHOTS:
    name, fn = SHOTDEF[s]
    clear(); fn()
    if SAVE and len(SHOTS) == 1:
        bpy.ops.wm.save_as_mainfile(filepath=SAVE, copy=True)
    r.filepath = os.path.join(OUT, name + SUFFIX + ".png")
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f"STILL {name} {time.time() - t0:.1f}s", flush=True)
