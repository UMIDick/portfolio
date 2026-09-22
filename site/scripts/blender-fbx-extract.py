"""
Запускается внутри Blender: выгружает из FBX (экспорт Revit) объекты, чьё имя начинается
с заданного префикса, в .npz — вершины (мировые координаты, м), треугольники и цвет
материала каждого треугольника. Нужен make-tower-ifc.py: навес на кровле башни —
импортированная в Revit геометрия, в IFC она не попадает, в FBX — есть.

blender -b --python scripts/blender-fbx-extract.py -- <file.fbx> <out.npz> <префикс имени>
"""

import sys

import bpy
import numpy as np

fbx, out, prefix = sys.argv[sys.argv.index("--") + 1 :][:3]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)

verts, tris, colors, names = [], [], [], []
off = 0
for o in bpy.context.scene.objects:
    if o.type != "MESH" or not o.name.startswith(prefix):
        continue
    me = o.data
    me.calc_loop_triangles()
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    m = np.array(o.matrix_world)
    co = co @ m[:3, :3].T + m[:3, 3]
    lt = me.loop_triangles
    t = np.empty(len(lt) * 3, np.int64)
    lt.foreach_get("vertices", t)
    mi = np.empty(len(lt), np.int64)
    lt.foreach_get("material_index", mi)
    pal = []
    for mat in me.materials:
        c = (0.8, 0.8, 0.8, 1.0)
        if mat is not None:
            c = tuple(mat.diffuse_color)
            if mat.use_nodes and mat.node_tree:
                bsdf = next((nd for nd in mat.node_tree.nodes if nd.type == "BSDF_PRINCIPLED"), None)
                if bsdf is not None:
                    c = tuple(bsdf.inputs["Base Color"].default_value)
        pal.append(c)
    pal = np.array(pal or [(0.8, 0.8, 0.8, 1.0)])
    verts.append(co)
    tris.append(t.reshape(-1, 3) + off)
    colors.append(pal[np.clip(mi, 0, len(pal) - 1)])
    names.append(o.name)
    off += n

np.savez_compressed(
    out,
    verts=np.concatenate(verts),
    tris=np.concatenate(tris),
    colors=np.concatenate(colors),
    names=np.array(names),
)
print(f"fbx: {len(names)} объектов, {off} вершин, {sum(len(t) for t in tris)} треугольников → {out}")
