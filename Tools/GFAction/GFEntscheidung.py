"""
GF-Entscheidungsdokumentation – TEGRITY Safety Engineering GmbH
CEO monthly decision documentation tool.
Generates a PDF directly using reportlab (no LaTeX required).
"""

import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import os
import datetime
import platform

if platform.system() == "Windows":
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

# ── German month names ────────────────────────────────────────────────────────
MONTHS_DE = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
]
MONTH_NUM = {m: i + 1 for i, m in enumerate(MONTHS_DE)}


# ── PDF generation ────────────────────────────────────────────────────────────

def _xml_escape(text: str) -> str:
    return (text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;"))


def build_pdf(data: dict, pdf_path: str) -> None:
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.units import mm
        from reportlab.lib import colors
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.platypus import (
            SimpleDocTemplate, Paragraph, Spacer,
            HRFlowable, Table, TableStyle, KeepTogether, Flowable,
        )
    except ImportError:
        raise ImportError(
            "reportlab ist nicht installiert.\n"
            "Bitte in der Konsole ausführen:\n\n"
            "    pip install reportlab"
        )

    PAGE_W, PAGE_H = A4
    MARGIN = 25 * mm
    BLUE  = colors.HexColor("#2b6cb0")
    DARK  = colors.HexColor("#1a202c")
    MUTED = colors.HexColor("#718096")

    def ps(name, **kw):
        base = dict(fontName="Helvetica", fontSize=10, leading=14, textColor=DARK)
        base.update(kw)
        return ParagraphStyle(name, **base)

    S_NORMAL  = ps("n")
    S_SECTION = ps("sec", fontName="Helvetica-Bold", fontSize=12,
                   textColor=BLUE, spaceAfter=2)
    S_SUB     = ps("sub", fontName="Helvetica-Oblique", fontSize=8, textColor=MUTED)
    S_TITLE   = ps("title", fontName="Helvetica-Bold", fontSize=16, alignment=1)
    S_MONTH   = ps("month", fontName="Helvetica-Bold", fontSize=12,
                   alignment=1, textColor=BLUE)
    S_MUTED_C = ps("mc", fontSize=9, alignment=1, textColor=MUTED)

    class CheckRow(Flowable):
        BOX = 9; SEP = 22; GAP = 5; HEIGHT = 18

        def __init__(self, options, selected):
            super().__init__()
            self.options  = options
            self.selected = selected
            self._cur_x   = 0

        def wrap(self, aw, _):
            return aw, self.HEIGHT

        def drawOn(self, canvas, x, y, _sW=0):
            self._cur_x = 0
            super().drawOn(canvas, x, y, _sW)

        def draw(self):
            c = self.canv
            B     = self.BOX
            y_mid = self.HEIGHT / 2
            y_box = y_mid - B / 2
            cx    = self._cur_x

            for opt in self.options:
                checked = opt == self.selected

                c.setLineWidth(0.9)
                c.setStrokeColorRGB(0.17, 0.42, 0.69)
                c.setFillColorRGB(1, 1, 1)
                c.rect(cx, y_box, B, B, fill=1, stroke=1)

                if checked:
                    pad = 2
                    c.setFillColorRGB(0.17, 0.42, 0.69)
                    c.rect(cx + pad, y_box + pad, B - 2*pad, B - 2*pad,
                           fill=1, stroke=0)

                c.setFillColorRGB(0.1, 0.13, 0.17)
                c.setFont("Helvetica", 9)
                tx = cx + B + self.GAP
                c.drawString(tx, y_mid - 3.2, opt)
                tw = c.stringWidth(opt, "Helvetica", 9)
                cx = tx + tw + self.SEP

            self._cur_x = cx

    story = []

    # ── Title block ───────────────────────────────────────────────────────────
    story.append(Spacer(1, 3*mm))
    story.append(Paragraph(
        "Geschäftsführer-Entscheidungsdokumentation", S_TITLE))
    story.append(Spacer(1, 2*mm))
    story.append(Paragraph(
        f"Berichtsmonat: {_xml_escape(data['month'])} {_xml_escape(data['year'])}",
        S_MONTH))
    story.append(Paragraph("TEGRITY Safety Engineering GmbH", S_MUTED_C))
    story.append(Paragraph(
        f"Geschäftsführer: {_xml_escape(data['author'])}", S_MUTED_C))
    story.append(Paragraph(
        f"Dokumentiert am: {_xml_escape(data['doc_date'])}", S_MUTED_C))
    story.append(Spacer(1, 3*mm))
    story.append(HRFlowable(width="100%", thickness=1, color=BLUE))
    story.append(Spacer(1, 5*mm))

    # ── Section builder ───────────────────────────────────────────────────────
    def add_section(num, title, subtitle, options, selected, comment_key,
                    remark_label="Bemerkung / Maßnahmen"):
        comment = _xml_escape(data.get(comment_key, "").strip())
        remark  = comment if comment else "<i>---</i>"
        story.append(KeepTogether([
            Paragraph(f"{num}.  {title}", S_SECTION),
            Paragraph(subtitle, S_SUB),
            Spacer(1, 2*mm),
            CheckRow(options, selected),
            Spacer(1, 2*mm),
            Paragraph(f"<b>{remark_label}:</b> {remark}", S_NORMAL),
        ]))
        story.append(Spacer(1, 5*mm))

    add_section(
        1, "Liquidität",
        "Beurteilung der Liquiditätssituation im Berichtsmonat.",
        ["OK", "NOK"], data["liquidity"], "liq_comment",
    )
    add_section(
        2, "Investitionen",
        "Entscheidung über Investitionsmaßnahmen im Berichtsmonat.",
        ["Maßnahmen erforderlich", "Keine Maßnahmen erforderlich"],
        data["investment"], "inv_comment",
    )
    add_section(
        3, "Fremdleistung / Subcontracting",
        "Entscheidung über den Einsatz von Stefan Koch als Subunternehmer.",
        ["Ja – S. Koch beauftragen", "Nein – nicht beauftragen"],
        data["subcontract"], "sub_comment",
        remark_label="Workpackage / Bemerkung",
    )
    add_section(
        4, "Auftragsannahme",
        "Entscheidung zur Annahme neuer Aufträge im Berichtsmonat.",
        ["Ja", "Nein"], data["order"], "ord_comment",
        remark_label="Details / Bemerkung",
    )

    cust = _xml_escape(data.get("cust_comment", "").strip())
    story.append(KeepTogether([
        Paragraph("5.  Kundenkommunikation", S_SECTION),
        Paragraph(
            "Wesentliche Themen und Entscheidungen in der Kundenkommunikation.",
            S_SUB),
        Spacer(1, 2*mm),
        Paragraph(cust if cust else "<i>---</i>", S_NORMAL),
    ]))
    story.append(Spacer(1, 5*mm))

    add_section(
        6, "Qualitätssicherung und Risiken",
        "Bewertung der Qualitätssituation und identifizierter Risiken.",
        ["Keine Auffälligkeiten", "Maßnahmen erforderlich"],
        data["quality"], "qual_comment",
    )

    # ── Signature block ───────────────────────────────────────────────────────
    story.append(Spacer(1, 8*mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=MUTED))
    story.append(Spacer(1, 10*mm))
    sig = Table(
        [["Ort, Datum:", "", "Unterschrift Geschäftsführer:"],
         ["", "", ""]],
        colWidths=[72*mm, 16*mm, 72*mm],
        rowHeights=[14, 1],
    )
    sig.setStyle(TableStyle([
        ("FONTNAME",       (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE",       (0, 0), (-1, -1), 10),
        ("VALIGN",         (0, 0), (-1, -1), "BOTTOM"),
        ("LINEBELOW",      (0, 1), (0, 1), 0.5, colors.black),
        ("LINEBELOW",      (2, 1), (2, 1), 0.5, colors.black),
        ("TOPPADDING",     (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING",  (0, 0), (-1, -1), 2),
    ]))
    story.append(sig)

    # ── Header / footer callback ──────────────────────────────────────────────
    def draw_page_deco(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica-Bold", 9)
        canvas.setFillColorRGB(0.1, 0.13, 0.17)
        canvas.drawString(MARGIN, PAGE_H - 17*mm,
                          "TEGRITY Safety Engineering GmbH")
        canvas.setFont("Helvetica", 9)
        canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 17*mm,
                               "GF-Entscheidungsdokumentation")
        canvas.setStrokeColor(BLUE)
        canvas.setLineWidth(0.4)
        canvas.line(MARGIN, PAGE_H - 19*mm, PAGE_W - MARGIN, PAGE_H - 19*mm)

        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(MARGIN, 14*mm,
                          "Vertraulich – Nur für interne Zwecke")
        canvas.drawRightString(PAGE_W - MARGIN, 14*mm, f"Seite {doc.page}")
        canvas.setStrokeColor(MUTED)
        canvas.setLineWidth(0.4)
        canvas.line(MARGIN, 17*mm, PAGE_W - MARGIN, 17*mm)
        canvas.restoreState()

    doc = SimpleDocTemplate(
        pdf_path,
        pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=25*mm, bottomMargin=25*mm,
        title=(f"GF-Entscheidungsdokumentation "
               f"{data['month']} {data['year']}"),
        author=data.get("author", ""),
    )
    doc.build(story, onFirstPage=draw_page_deco, onLaterPages=draw_page_deco)


# ── GUI Application ───────────────────────────────────────────────────────────

HDR_BG  = "#1a365d"
HDR_FG  = "#ffffff"
HDR_SUB = "#90b4d0"
BODY_BG = "#f7fafc"
CARD_BG = "#ffffff"
ACCENT  = "#2b6cb0"
TEXT_C  = "#1a202c"
MUTED_C = "#4a5568"
SEP_C   = "#cbd5e0"


class GFActionApp:

    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("GF-Entscheidungsdokumentation – TEGRITY")
        self.root.geometry("820x900")
        self.root.configure(bg=BODY_BG)

        today = datetime.date.today()
        self.month_var  = tk.StringVar(value=MONTHS_DE[today.month - 1])
        self.year_var   = tk.StringVar(value=str(today.year))
        self.author_var = tk.StringVar(value="Stefan Sawatzky")

        self.liquidity_var   = tk.StringVar(value="OK")
        self.investment_var  = tk.StringVar(value="Keine Maßnahmen erforderlich")
        self.subcontract_var = tk.StringVar(value="Nein – nicht beauftragen")
        self.order_var       = tk.StringVar(value="Ja")
        self.quality_var     = tk.StringVar(value="Keine Auffälligkeiten")

        self._build_ui()

    # ── Layout ────────────────────────────────────────────────────────────────

    def _build_ui(self):
        hdr = tk.Frame(self.root, bg=HDR_BG, pady=14)
        hdr.pack(fill=tk.X)
        tk.Label(hdr, text="TEGRITY Safety Engineering GmbH",
                 bg=HDR_BG, fg=HDR_FG, font=("Arial", 14, "bold")).pack()
        tk.Label(hdr, text="Geschäftsführer  ·  Monatliche Entscheidungsdokumentation",
                 bg=HDR_BG, fg=HDR_SUB, font=("Arial", 9)).pack()

        outer = tk.Frame(self.root, bg=BODY_BG)
        outer.pack(fill=tk.BOTH, expand=True)

        canvas = tk.Canvas(outer, bg=BODY_BG, highlightthickness=0)
        vsb    = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=vsb.set)
        vsb.pack(side=tk.RIGHT, fill=tk.Y)
        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.body = tk.Frame(canvas, bg=BODY_BG)
        win_id    = canvas.create_window((0, 0), window=self.body, anchor="nw")

        def _resize(e):
            canvas.itemconfig(win_id, width=e.width)
        canvas.bind("<Configure>", _resize)
        self.body.bind("<Configure>",
                       lambda _: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind_all("<MouseWheel>",
                        lambda e: canvas.yview_scroll(-1 if e.delta > 0 else 1, "units"))

        self._build_meta()
        self._build_section_liquidity()
        self._build_section_investment()
        self._build_section_subcontract()
        self._build_section_order()
        self._build_section_customer()
        self._build_section_quality()
        self._build_action_bar()

    def _card(self, title: str, subtitle: str = "") -> tk.Frame:
        wrapper = tk.Frame(self.body, bg=BODY_BG, padx=16, pady=6)
        wrapper.pack(fill=tk.X)

        strip = tk.Frame(wrapper, bg=ACCENT)
        strip.pack(fill=tk.X)
        tk.Label(strip, text=f"  {title}", bg=ACCENT, fg="white",
                 font=("Arial", 10, "bold"), pady=5, anchor=tk.W).pack(side=tk.LEFT)
        if subtitle:
            tk.Label(strip, text=f"{subtitle}  ", bg=ACCENT, fg="#bee3f8",
                     font=("Arial", 8), pady=5).pack(side=tk.RIGHT)

        inner = tk.Frame(wrapper, bg=CARD_BG, bd=1, relief=tk.SOLID,
                         padx=14, pady=10)
        inner.pack(fill=tk.X)
        return inner

    def _radio_row(self, parent: tk.Frame, var: tk.StringVar, options: list):
        row = tk.Frame(parent, bg=CARD_BG)
        row.pack(fill=tk.X, pady=(4, 2))
        for opt in options:
            tk.Radiobutton(
                row, text=opt, variable=var, value=opt,
                bg=CARD_BG, fg=TEXT_C, activebackground=CARD_BG,
                selectcolor="#ebf8ff", font=("Arial", 9),
            ).pack(side=tk.LEFT, padx=(0, 18))

    def _comment_box(self, parent: tk.Frame, height: int = 2) -> tk.Text:
        tk.Label(parent, text="Bemerkung / Kommentar:",
                 bg=CARD_BG, fg=MUTED_C, font=("Arial", 8, "italic")
                 ).pack(anchor=tk.W, pady=(6, 2))
        t = tk.Text(parent, height=height, font=("Arial", 9),
                    bg="#f0f7ff", fg=TEXT_C, relief=tk.SOLID, bd=1,
                    wrap=tk.WORD, padx=6, pady=4)
        t.pack(fill=tk.X)
        return t

    # ── Meta block ────────────────────────────────────────────────────────────

    def _build_meta(self):
        meta = tk.Frame(self.body, bg=BODY_BG, padx=16, pady=10)
        meta.pack(fill=tk.X)

        row = tk.Frame(meta, bg=BODY_BG)
        row.pack(fill=tk.X)

        for col, (lbl, widget_fn) in enumerate([
            ("Monat",        lambda r: ttk.Combobox(r, textvariable=self.month_var,
                                                    values=MONTHS_DE, width=13,
                                                    state="readonly")),
            ("Jahr",         lambda r: ttk.Spinbox(r, from_=2020, to=2040,
                                                   textvariable=self.year_var, width=6)),
            ("Erstellt von", lambda r: ttk.Entry(r, textvariable=self.author_var, width=22)),
        ]):
            tk.Label(row, text=lbl + ":", bg=BODY_BG, fg=TEXT_C,
                     font=("Arial", 9, "bold")).grid(
                row=0, column=col * 2, sticky=tk.W,
                padx=(12 if col else 0, 4))
            widget_fn(row).grid(row=0, column=col * 2 + 1, padx=(0, 16))

        tk.Frame(self.body, bg=SEP_C, height=1).pack(fill=tk.X, padx=16, pady=2)

    # ── Decision sections ─────────────────────────────────────────────────────

    def _build_section_liquidity(self):
        f = self._card("1.  Liquidität", "OK / NOK")
        self._radio_row(f, self.liquidity_var, ["OK", "NOK"])
        self.liq_cmt = self._comment_box(f, height=2)

    def _build_section_investment(self):
        f = self._card("2.  Investitionen", "Maßnahmen / Keine Maßnahmen")
        self._radio_row(f, self.investment_var,
                        ["Maßnahmen erforderlich", "Keine Maßnahmen erforderlich"])
        self.inv_cmt = self._comment_box(f, height=2)

    def _build_section_subcontract(self):
        f = self._card("3.  Fremdleistung / Subcontracting", "S. Koch Ja / Nein")
        self._radio_row(f, self.subcontract_var,
                        ["Ja – S. Koch beauftragen", "Nein – nicht beauftragen"])
        self.sub_cmt = self._comment_box(f, height=2)

    def _build_section_order(self):
        f = self._card("4.  Auftragsannahme", "Ja / Nein")
        self._radio_row(f, self.order_var, ["Ja", "Nein"])
        self.ord_cmt = self._comment_box(f, height=2)

    def _build_section_customer(self):
        f = self._card("5.  Kundenkommunikation", "Freitext")
        tk.Label(f, text="Wesentliche Themen, Entscheidungen und Maßnahmen:",
                 bg=CARD_BG, fg=MUTED_C, font=("Arial", 8, "italic")
                 ).pack(anchor=tk.W, pady=(2, 2))
        self.cust_cmt = tk.Text(f, height=4, font=("Arial", 9),
                                bg="#f0f7ff", fg=TEXT_C, relief=tk.SOLID, bd=1,
                                wrap=tk.WORD, padx=6, pady=4)
        self.cust_cmt.pack(fill=tk.X)

    def _build_section_quality(self):
        f = self._card("6.  Qualitätssicherung und Risiken", "Bewertung Qualität / Risiken")
        self._radio_row(f, self.quality_var,
                        ["Keine Auffälligkeiten", "Maßnahmen erforderlich"])
        self.qual_cmt = self._comment_box(f, height=2)

    # ── Action bar ────────────────────────────────────────────────────────────

    def _build_action_bar(self):
        bar = tk.Frame(self.body, bg=BODY_BG, padx=16, pady=14)
        bar.pack(fill=tk.X)

        tk.Button(bar, text="  PDF generieren  ", command=self._generate,
                  bg=ACCENT, fg="white", font=("Arial", 11, "bold"),
                  padx=10, pady=8, relief=tk.FLAT, cursor="hand2",
                  activebackground="#2c5282", activeforeground="white",
                  ).pack(side=tk.LEFT, padx=(0, 8))

        tk.Button(bar, text="Felder zurücksetzen", command=self._reset,
                  bg="#718096", fg="white", font=("Arial", 10),
                  padx=10, pady=8, relief=tk.FLAT, cursor="hand2",
                  activebackground="#4a5568", activeforeground="white",
                  ).pack(side=tk.LEFT)

    # ── Data collection ───────────────────────────────────────────────────────

    def _collect(self) -> dict:
        return {
            "month":        self.month_var.get(),
            "year":         self.year_var.get(),
            "author":       self.author_var.get(),
            "doc_date":     datetime.date.today().strftime("%d.%m.%Y"),
            "liquidity":    self.liquidity_var.get(),
            "investment":   self.investment_var.get(),
            "subcontract":  self.subcontract_var.get(),
            "order":        self.order_var.get(),
            "quality":      self.quality_var.get(),
            "liq_comment":  self.liq_cmt.get("1.0",  tk.END).strip(),
            "inv_comment":  self.inv_cmt.get("1.0",  tk.END).strip(),
            "sub_comment":  self.sub_cmt.get("1.0",  tk.END).strip(),
            "ord_comment":  self.ord_cmt.get("1.0",  tk.END).strip(),
            "cust_comment": self.cust_cmt.get("1.0", tk.END).strip(),
            "qual_comment": self.qual_cmt.get("1.0", tk.END).strip(),
        }

    def _reset(self):
        today = datetime.date.today()
        self.month_var.set(MONTHS_DE[today.month - 1])
        self.year_var.set(str(today.year))
        self.author_var.set("Stefan Sawatzky")
        self.liquidity_var.set("OK")
        self.investment_var.set("Keine Maßnahmen erforderlich")
        self.subcontract_var.set("Nein – nicht beauftragen")
        self.order_var.set("Ja")
        self.quality_var.set("Keine Auffälligkeiten")
        for widget in (self.liq_cmt, self.inv_cmt, self.sub_cmt,
                       self.ord_cmt, self.cust_cmt, self.qual_cmt):
            widget.delete("1.0", tk.END)

    # ── PDF generation ────────────────────────────────────────────────────────

    def _generate(self):
        data = self._collect()

        out_dir   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
        os.makedirs(out_dir, exist_ok=True)
        month_num = MONTH_NUM.get(data["month"], 1)
        base      = f"GF_Entscheidung_{data['year']}_{month_num:02d}"

        pdf_path = filedialog.asksaveasfilename(
            initialdir=out_dir,
            initialfile=base + ".pdf",
            defaultextension=".pdf",
            filetypes=[("PDF-Datei", "*.pdf"), ("Alle Dateien", "*.*")],
            title="PDF speichern unter",
        )
        if not pdf_path:
            return

        try:
            build_pdf(data, pdf_path)
        except ImportError as exc:
            messagebox.showerror("Fehlende Bibliothek", str(exc))
            return
        except Exception as exc:
            messagebox.showerror("Fehler",
                                 f"PDF konnte nicht erstellt werden:\n{exc}")
            return

        open_it = messagebox.askyesno(
            "PDF erstellt",
            f"Dokument erfolgreich erstellt:\n{pdf_path}\n\nPDF jetzt öffnen?"
        )
        if open_it:
            if platform.system() == "Windows":
                os.startfile(pdf_path)
            elif platform.system() == "Darwin":
                import subprocess
                subprocess.run(["open", pdf_path])
            else:
                import subprocess
                subprocess.run(["xdg-open", pdf_path])


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    root = tk.Tk()
    app  = GFActionApp(root)
    root.mainloop()
