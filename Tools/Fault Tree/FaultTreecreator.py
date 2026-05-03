import tkinter as tk
from tkinter import messagebox, filedialog, simpledialog
import json, math, platform

if platform.system() == "Windows":
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

# ── Node types ────────────────────────────────────────────────────────────────
NODE_TOP    = "TOP"
NODE_AND    = "AND"
NODE_OR     = "OR"
NODE_INTERM = "INTERM"   # intermediate event (rounded rect)
NODE_EVENT  = "EVENT"    # basic event (circle)
NODE_HOUSE  = "HOUSE"    # house event (triangle)

# ── Layout ────────────────────────────────────────────────────────────────────
W        = 110    # bounding-box width (all node types)
H        = 68     # bounding-box height
DOME_H   = 20     # height of AND/OR dome above body rectangle
SNAP     = 40     # grid snap

# ── Palette (matches reference image) ────────────────────────────────────────
BG_C      = "#ffffff"   # canvas
FILL_C    = "#8DC4DE"   # all node fill
OUTLINE_C = "#5AAEC8"   # all node outline
LINE_C    = "#2c3e50"   # connection lines
TEXT_C    = "#1a2b3c"   # text
SEL_C     = "#E07820"   # hover / connect highlight


# ── Shape helpers ─────────────────────────────────────────────────────────────

def _rounded_rect_pts(x, y, r=9, steps=6):
    x1, y1, x2, y2 = x-W//2, y-H//2, x+W//2, y+H//2
    pts = []
    for (a0, cx, cy) in [(-90, x2-r, y1+r), (0, x2-r, y2-r),
                          (90,  x1+r, y2-r), (180, x1+r, y1+r)]:
        for j in range(steps + 1):
            a = math.radians(a0 + 90 * j / steps)
            pts += [cx + r*math.cos(a), cy + r*math.sin(a)]
    return pts

def _dome_gate_pts(x, y, steps=20):
    """AND / OR gate: half-ellipse dome on top, rectangle body below."""
    x1, y1, x2, y2 = x-W//2, y-H//2, x+W//2, y+H//2
    dome_base = y1 + DOME_H   # where dome meets the rectangular body
    dome_ry   = dome_base - y1  # vertical radius of dome ellipse

    pts = []
    # Half-ellipse: from left base → apex → right base
    for i in range(steps + 1):
        a = math.radians(180 - 180*i/steps)      # 180° → 0°
        pts += [x + (W//2)*math.cos(a),
                dome_base - dome_ry * abs(math.sin(a))]
    # Rectangle body (close polygon)
    pts += [x2, y2, x1, y2]
    return pts

def _house_pts(x, y):
    x1, y1, x2, y2 = x-W//2, y-H//2, x+W//2, y+H//2
    return [x, y1, x2, y1+H//3, x2, y2, x1, y2, x1, y1+H//3]

def _pt_seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2-x1, y2-y1
    L2 = dx*dx + dy*dy
    if L2 == 0:
        return math.hypot(px-x1, py-y1)
    t  = max(0.0, min(1.0, ((px-x1)*dx + (py-y1)*dy) / L2))
    return math.hypot(px-(x1+t*dx), py-(y1+t*dy))


# ── Node data class ───────────────────────────────────────────────────────────

class Node:
    _counter = 0

    def __init__(self, kind, x, y, label=None):
        Node._counter += 1
        self.id       = Node._counter
        self.kind     = kind
        self.x        = x
        self.y        = y
        self.label    = label or f"{kind}{self.id}"
        self.children: list[int] = []
        self.shape_id = None
        self.text_id  = None
        self.arc_id   = None   # OR gate bottom arc

    def rect(self):
        return self.x-W//2, self.y-H//2, self.x+W//2, self.y+H//2


# ── Application ───────────────────────────────────────────────────────────────

class FaultTreeApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Fault Tree Creator")
        self.root.geometry("1280x820")
        self.root.configure(bg="#f0f4f8")

        self.nodes: dict[int, Node] = {}
        self.edges: dict[tuple, int] = {}   # (pid, cid) → line id

        self.tool        = tk.StringVar(value="SELECT")
        self.drag_node   = None
        self.drag_ox     = 0
        self.drag_oy     = 0
        self.drag_start  = None
        self.did_drag    = False
        self.hovered_node: int | None = None
        self.connect_from: int | None = None
        self._edge_preview = None

        self._build_ui()

    # ── UI ────────────────────────────────────────────────────────────────────

    def _build_ui(self):
        TB = "#f0f4f8"
        TBBORDER = "#c8d4dc"

        tb = tk.Frame(self.root, bg=TB, pady=6)
        tb.pack(side=tk.TOP, fill=tk.X)
        tk.Frame(self.root, bg=TBBORDER, height=1).pack(side=tk.TOP, fill=tk.X)

        tools = [
            ("▶  Select",       "SELECT"),
            ("⬜  Top Event",    NODE_TOP),
            ("∧  AND Gate",     NODE_AND),
            ("∨  OR Gate",      NODE_OR),
            ("▭  Intermediate", NODE_INTERM),
            ("●  Basic Event",  NODE_EVENT),
            ("⌂  House",        NODE_HOUSE),
            ("⟶  Connect",     "CONNECT"),
            ("✕  Delete",       "DELETE"),
        ]
        for text, val in tools:
            is_util = val in ("SELECT", "CONNECT", "DELETE")
            bg  = "#dce8f0" if is_util else FILL_C
            sel = "#b8ccd8" if is_util else OUTLINE_C
            tk.Radiobutton(
                tb, text=text, variable=self.tool, value=val,
                bg=bg, fg=TEXT_C, selectcolor=sel,
                activebackground=OUTLINE_C, activeforeground=TEXT_C,
                indicatoron=False, padx=9, pady=5,
                relief=tk.FLAT, bd=1,
                font=("Arial", 9), cursor="hand2",
                command=self._on_tool_change,
            ).pack(side=tk.LEFT, padx=2)

        tk.Frame(tb, bg=TBBORDER, width=1).pack(side=tk.LEFT, fill=tk.Y, padx=8)

        for text, cmd in [("New", self._new), ("Save", self._save), ("Load", self._load)]:
            tk.Button(
                tb, text=text, command=cmd,
                bg="#dce8f0", fg=TEXT_C, activebackground=OUTLINE_C,
                font=("Arial", 9), padx=10, pady=4,
                relief=tk.FLAT, bd=1, cursor="hand2",
            ).pack(side=tk.RIGHT, padx=2)

        self.status_var = tk.StringVar(
            value="SELECT — click gate to add children  |  drag to move  |  right-click AND/OR to toggle"
        )
        tk.Frame(self.root, bg=TBBORDER, height=1).pack(side=tk.BOTTOM, fill=tk.X)
        tk.Label(
            self.root, textvariable=self.status_var, anchor=tk.W,
            bg=TB, fg="#607080", pady=3, padx=10, font=("Arial", 8),
        ).pack(side=tk.BOTTOM, fill=tk.X)

        frame = tk.Frame(self.root)
        frame.pack(fill=tk.BOTH, expand=True)

        self.canvas = tk.Canvas(frame, bg=BG_C, cursor="crosshair", highlightthickness=0)
        hb = tk.Scrollbar(frame, orient=tk.HORIZONTAL, command=self.canvas.xview)
        vb = tk.Scrollbar(frame, orient=tk.VERTICAL,   command=self.canvas.yview)
        self.canvas.configure(xscrollcommand=hb.set, yscrollcommand=vb.set,
                              scrollregion=(-2000, -2000, 4000, 4000))
        hb.pack(side=tk.BOTTOM, fill=tk.X)
        vb.pack(side=tk.RIGHT,  fill=tk.Y)
        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.canvas.bind("<Button-1>",        self._on_click)
        self.canvas.bind("<B1-Motion>",       self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<Double-Button-1>", self._on_double_click)
        self.canvas.bind("<Motion>",          self._on_motion)
        self.canvas.bind("<Button-3>",        self._on_right_click)
        self.canvas.bind("<Button-2>",        self._pan_start)
        self.canvas.bind("<B2-Motion>",       self._pan_move)
        self.canvas.bind("<MouseWheel>",      self._on_mousewheel)

        self._draw_grid()

    def _draw_grid(self):
        for x in range(-2000, 4000, SNAP):
            self.canvas.create_line(x, -2000, x, 4000, fill="#edf1f4", tags="grid")
        for y in range(-2000, 4000, SNAP):
            self.canvas.create_line(-2000, y, 4000, y, fill="#edf1f4", tags="grid")
        self.canvas.tag_lower("grid")

    # ── Tool changes ──────────────────────────────────────────────────────────

    def _on_tool_change(self):
        self._cancel_connect()
        msgs = {
            "SELECT":    "SELECT — click gate/event to add children  |  drag to move  |  right-click AND/OR to toggle",
            "CONNECT":   "CONNECT — click parent then child",
            "DELETE":    "DELETE — click a node or line to remove",
            NODE_TOP:    "TOP EVENT — click canvas to place (only one allowed)",
            NODE_AND:    "AND GATE — click canvas to place",
            NODE_OR:     "OR GATE — click canvas to place",
            NODE_INTERM: "INTERMEDIATE EVENT — click canvas to place",
            NODE_EVENT:  "BASIC EVENT — click canvas to place",
            NODE_HOUSE:  "HOUSE EVENT — click canvas to place",
        }
        self.status_var.set(msgs.get(self.tool.get(), ""))

    # ── Coordinate helpers ────────────────────────────────────────────────────

    def _cx(self, e): return self.canvas.canvasx(e.x)
    def _cy(self, e): return self.canvas.canvasy(e.y)

    # ── Hit testing ───────────────────────────────────────────────────────────

    def _node_at(self, cx, cy):
        for node in self.nodes.values():
            x1, y1, x2, y2 = node.rect()
            if x1 <= cx <= x2 and y1 <= cy <= y2:
                return node
        return None

    def _edge_at(self, cx, cy):
        TOL = 7
        for (pid, cid) in self.edges:
            p, c = self.nodes[pid], self.nodes[cid]
            x1, y1 = p.x, p.y + H//2
            x2, y2 = c.x, c.y - H//2
            mid_y = (y1 + y2) // 2
            for seg in [(x1,y1,x1,mid_y),(x1,mid_y,x2,mid_y),(x2,mid_y,x2,y2)]:
                if _pt_seg_dist(cx, cy, *seg) <= TOL:
                    return (pid, cid)
        return None

    # ── Mouse events ─────────────────────────────────────────────────────────

    def _on_click(self, event):
        cx, cy = self._cx(event), self._cy(event)
        t = self.tool.get()

        if t in (NODE_TOP, NODE_AND, NODE_OR, NODE_INTERM, NODE_EVENT, NODE_HOUSE):
            self._place_node(t, cx, cy)

        elif t == "SELECT":
            node = self._node_at(cx, cy)
            if node:
                self.drag_node  = node
                self.drag_ox    = cx - node.x
                self.drag_oy    = cy - node.y
                self.drag_start = (cx, cy)
                self.did_drag   = False

        elif t == "CONNECT":
            node = self._node_at(cx, cy)
            if node:
                if self.connect_from is None:
                    self.connect_from = node.id
                    self._draw_node(node)   # redraws with connect highlight
                    self.status_var.set("CONNECT — now click the child node")
                else:
                    if node.id != self.connect_from:
                        self._add_edge(self.connect_from, node.id)
                    self._cancel_connect()

        elif t == "DELETE":
            node = self._node_at(cx, cy)
            if node:
                self._delete_node(node)
            else:
                edge = self._edge_at(cx, cy)
                if edge:
                    self._delete_edge(*edge)

    def _on_drag(self, event):
        cx, cy = self._cx(event), self._cy(event)
        t = self.tool.get()

        if t == "SELECT" and self.drag_node:
            if self.drag_start:
                sx, sy = self.drag_start
                if not self.did_drag and abs(cx-sx) < 6 and abs(cy-sy) < 6:
                    return
            self.did_drag = True
            self._move_node(self.drag_node, cx - self.drag_ox, cy - self.drag_oy)

        elif t == "CONNECT" and self.connect_from is not None:
            src = self.nodes[self.connect_from]
            if self._edge_preview:
                self.canvas.delete(self._edge_preview)
            self._edge_preview = self.canvas.create_line(
                src.x, src.y, cx, cy,
                dash=(5, 4), fill=LINE_C, width=1.5, tags="preview"
            )

    def _on_release(self, _event):
        if self.tool.get() == "SELECT":
            node = self.drag_node
            if node and not self.did_drag and node.kind in (NODE_TOP, NODE_AND, NODE_OR, NODE_INTERM):
                self._auto_add_children(node)
            self.drag_node  = None
            self.drag_start = None
            self.did_drag   = False

    def _on_double_click(self, event):
        node = self._node_at(self._cx(event), self._cy(event))
        if node:
            self._rename_node(node)

    def _on_motion(self, event):
        cx, cy = self._cx(event), self._cy(event)

        if self.tool.get() == "CONNECT" and self.connect_from is not None:
            src = self.nodes[self.connect_from]
            if self._edge_preview:
                self.canvas.delete(self._edge_preview)
            self._edge_preview = self.canvas.create_line(
                src.x, src.y, cx, cy,
                dash=(5, 4), fill=LINE_C, width=1.5, tags="preview"
            )

        node = self._node_at(cx, cy)
        new_id = node.id if node else None
        if new_id != self.hovered_node:
            old_id = self.hovered_node
            self.hovered_node = new_id
            if old_id and old_id in self.nodes:
                self._draw_node(self.nodes[old_id])
            if new_id and new_id in self.nodes:
                self._draw_node(self.nodes[new_id])

    def _on_right_click(self, event):
        cx, cy = self._cx(event), self._cy(event)
        node = self._node_at(cx, cy)
        if node and node.kind in (NODE_AND, NODE_OR):
            self._toggle_gate_type(node)
        elif node:
            self._show_context_menu(event, node)

    def _toggle_gate_type(self, node: Node):
        node.kind = NODE_OR if node.kind == NODE_AND else NODE_AND
        self._draw_node(node)
        self._redraw_edges_for(node)
        self.status_var.set(f"'{node.label}' toggled to {node.kind}")

    # ── Panning ───────────────────────────────────────────────────────────────

    def _pan_start(self, event):  self.canvas.scan_mark(event.x, event.y)
    def _pan_move(self, event):   self.canvas.scan_dragto(event.x, event.y, gain=1)
    def _on_mousewheel(self, event):
        self.canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")

    # ── Node placement ────────────────────────────────────────────────────────

    def _place_node(self, kind, cx, cy):
        cx = round(cx / SNAP) * SNAP
        cy = round(cy / SNAP) * SNAP
        if kind == NODE_TOP and any(n.kind == NODE_TOP for n in self.nodes.values()):
            messagebox.showwarning("Top Event", "Only one Top Event is allowed.")
            return
        node = Node(kind, cx, cy)
        self.nodes[node.id] = node
        self._draw_node(node)
        self.status_var.set(f"Placed '{node.label}'  —  double-click to rename")

    # ── Drawing ───────────────────────────────────────────────────────────────

    def _draw_node(self, node: Node):
        self.canvas.delete(f"node-{node.id}")
        node.shape_id = node.text_id = node.arc_id = None

        x, y   = node.x, node.y
        x1, y1, x2, y2 = node.rect()
        tag    = f"node-{node.id}"

        hovered    = (self.hovered_node   == node.id)
        connecting = (self.connect_from   == node.id)
        hi         = hovered or connecting
        oc = SEL_C if hi else OUTLINE_C
        ow = 2.5   if hi else 1.5

        if node.kind in (NODE_AND, NODE_OR):
            # Gate: half-ellipse dome + rectangle body
            pts = _dome_gate_pts(x, y)
            node.shape_id = self.canvas.create_polygon(
                pts, fill=FILL_C, outline=oc, width=ow, tags=tag
            )
            # OR gate: concave arc at bottom to distinguish from AND
            if node.kind == NODE_OR:
                node.arc_id = self.canvas.create_arc(
                    x1+4, y2-12, x2-4, y2+6,
                    start=0, extent=-180,          # curves downward
                    style=tk.ARC, outline=oc, width=ow, tags=tag
                )
            # Label centred in body area (below dome)
            body_cy = y1 + DOME_H + (H - DOME_H) // 2
            node.text_id = self.canvas.create_text(
                x, body_cy, text=node.label,
                fill=TEXT_C, font=("Arial", 9, "bold"),
                width=W - 14, justify=tk.CENTER, tags=tag
            )

        elif node.kind == NODE_EVENT:
            # Circle – basic event
            r = 27
            node.shape_id = self.canvas.create_oval(
                x-r, y-r, x+r, y+r,
                fill=FILL_C, outline=oc, width=ow, tags=tag
            )
            node.text_id = self.canvas.create_text(
                x, y, text=node.label,
                fill=TEXT_C, font=("Arial", 9, "bold"),
                width=r*2 - 8, justify=tk.CENTER, tags=tag
            )

        elif node.kind == NODE_HOUSE:
            pts = _house_pts(x, y)
            node.shape_id = self.canvas.create_polygon(
                pts, fill=FILL_C, outline=oc, width=ow, tags=tag
            )
            node.text_id = self.canvas.create_text(
                x, y + H//6, text=node.label,
                fill=TEXT_C, font=("Arial", 9, "bold"),
                width=W - 20, justify=tk.CENTER, tags=tag
            )

        else:  # NODE_TOP, NODE_INTERM – rounded rectangle
            pts = _rounded_rect_pts(x, y)
            node.shape_id = self.canvas.create_polygon(
                pts, fill=FILL_C, outline=oc, width=ow, tags=tag
            )
            node.text_id = self.canvas.create_text(
                x, y, text=node.label,
                fill=TEXT_C, font=("Arial", 9),
                width=W - 16, justify=tk.CENTER, tags=tag
            )

        self.canvas.tag_lower("edge")
        self.canvas.tag_lower("grid")

    def _draw_edge(self, parent: Node, child: Node) -> int:
        """Orthogonal 3-segment connection: down → across → down. No arrowhead."""
        x1, y1 = parent.x, parent.y + H//2
        x2, y2 = child.x,  child.y  - H//2
        mid_y = (y1 + y2) // 2

        line_id = self.canvas.create_line(
            x1, y1,    x1, mid_y,
            x2, mid_y, x2, y2,
            fill=LINE_C, width=1.5, tags="edge"
        )
        self.canvas.tag_lower("edge")
        self.canvas.tag_lower("grid")
        return line_id

    def _redraw_edges_for(self, node: Node):
        for (pid, cid) in list(self.edges):
            if pid == node.id or cid == node.id:
                self.canvas.delete(self.edges[(pid, cid)])
                self.edges[(pid, cid)] = self._draw_edge(self.nodes[pid], self.nodes[cid])

    # ── Node operations ───────────────────────────────────────────────────────

    def _move_node(self, node: Node, nx, ny):
        node.x = round(nx / SNAP) * SNAP
        node.y = round(ny / SNAP) * SNAP
        self._draw_node(node)
        self._redraw_edges_for(node)

    def _rename_node(self, node: Node):
        new_lbl = simpledialog.askstring(
            "Rename", f"Label for {node.kind}:",
            initialvalue=node.label, parent=self.root
        )
        if new_lbl:
            node.label = new_lbl
            self._draw_node(node)

    def _add_edge(self, pid: int, cid: int):
        if (pid, cid) in self.edges or pid == cid:
            return
        line_id = self._draw_edge(self.nodes[pid], self.nodes[cid])
        self.edges[(pid, cid)] = line_id
        self.nodes[pid].children.append(cid)

    def _delete_node(self, node: Node):
        for key in [k for k in self.edges if node.id in k]:
            self.canvas.delete(self.edges.pop(key))
        for n in self.nodes.values():
            if node.id in n.children:
                n.children.remove(node.id)
        self.canvas.delete(f"node-{node.id}")
        del self.nodes[node.id]

    def _delete_edge(self, pid: int, cid: int):
        if (pid, cid) in self.edges:
            self.canvas.delete(self.edges.pop((pid, cid)))
        p = self.nodes.get(pid)
        if p and cid in p.children:
            p.children.remove(cid)

    def _cancel_connect(self):
        if self.connect_from is not None:
            old = self.nodes.get(self.connect_from)
            self.connect_from = None
            if old:
                self._draw_node(old)   # remove highlight
        if self._edge_preview:
            self.canvas.delete(self._edge_preview)
            self._edge_preview = None
        self.status_var.set("CONNECT — click parent node then child node")

    def _auto_add_children(self, parent: Node):
        VERT  = 120
        HORIZ = 140

        existing = [self.nodes[cid] for cid in parent.children if cid in self.nodes]

        # Alternate: gates add event boxes, event boxes add gates
        if parent.kind in (NODE_AND, NODE_OR):
            child_kind = NODE_INTERM
            n_add = 2 if not existing else 1
        else:  # TOP, INTERM
            child_kind = NODE_AND
            n_add = 1

        if not existing:
            if n_add == 2:
                positions = [(parent.x - HORIZ//2, parent.y + VERT),
                             (parent.x + HORIZ//2, parent.y + VERT)]
            else:
                positions = [(parent.x, parent.y + VERT)]
        else:
            rightmost = max(c.x for c in existing)
            positions  = [(rightmost + HORIZ, existing[0].y)]

        for px, py in positions:
            child = Node(child_kind, round(px/SNAP)*SNAP, round(py/SNAP)*SNAP)
            self.nodes[child.id] = child
            self._draw_node(child)
            self._add_edge(parent.id, child.id)

        self.status_var.set(
            f"Added {len(positions)} child(ren) to '{parent.label}'"
            " — right-click AND/OR to toggle type"
        )

    # ── Context menu ──────────────────────────────────────────────────────────

    def _show_context_menu(self, event, node: Node):
        m = tk.Menu(self.root, tearoff=False)
        m.add_command(label=f"[{node.kind}]  {node.label}", state=tk.DISABLED)
        m.add_separator()
        m.add_command(label="Rename…",      command=lambda: self._rename_node(node))
        m.add_command(label="Delete node",  command=lambda: self._delete_node(node))
        m.add_separator()
        m.add_command(label="Connect from here",
                      command=lambda: self._start_connect_from(node))
        m.post(event.x_root, event.y_root)

    def _start_connect_from(self, node: Node):
        self.tool.set("CONNECT")
        self._cancel_connect()
        self.connect_from = node.id
        self._draw_node(node)
        self.status_var.set("CONNECT — now click the child node")

    # ── Serialisation ─────────────────────────────────────────────────────────

    def _tree_to_dict(self):
        return {
            "nodes": {
                str(nid): {"kind": n.kind, "x": n.x, "y": n.y,
                            "label": n.label, "children": n.children}
                for nid, n in self.nodes.items()
            },
            "counter": Node._counter,
        }

    def _dict_to_tree(self, data):
        self._new(confirm=False)
        Node._counter = data.get("counter", 0)
        for nid_str, nd in data["nodes"].items():
            nid = int(nid_str)
            node = Node.__new__(Node)
            node.id       = nid
            node.kind     = nd["kind"]
            node.x        = nd["x"]
            node.y        = nd["y"]
            node.label    = nd["label"]
            node.children = nd["children"]
            node.shape_id = node.text_id = node.arc_id = None
            self.nodes[nid] = node
            self._draw_node(node)
        for nid, node in self.nodes.items():
            for cid in node.children:
                if cid in self.nodes:
                    self.edges[(nid, cid)] = self._draw_edge(node, self.nodes[cid])

    # ── File ops ──────────────────────────────────────────────────────────────

    def _new(self, confirm=True):
        if confirm and self.nodes:
            if not messagebox.askyesno("New", "Discard current tree?"):
                return
        self.canvas.delete("all")
        self.nodes.clear()
        self.edges.clear()
        self.connect_from = None
        self._edge_preview = None
        self.hovered_node  = None
        Node._counter = 0
        self._draw_grid()

    def _save(self):
        path = filedialog.asksaveasfilename(
            defaultextension=".json",
            filetypes=[("Fault Tree JSON", "*.json"), ("All files", "*.*")],
            title="Save Fault Tree",
        )
        if path:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(self._tree_to_dict(), f, indent=2)
            self.status_var.set(f"Saved: {path}")

    def _load(self):
        path = filedialog.askopenfilename(
            filetypes=[("Fault Tree JSON", "*.json"), ("All files", "*.*")],
            title="Open Fault Tree",
        )
        if path:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            self._dict_to_tree(data)
            self.status_var.set(f"Loaded: {path}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    root = tk.Tk()
    app  = FaultTreeApp(root)
    root.mainloop()
