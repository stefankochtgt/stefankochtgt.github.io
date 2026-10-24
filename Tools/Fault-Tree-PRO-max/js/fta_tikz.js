// The fault tree as a TikZ picture, in the browser (standalone Fault Tree PRO max, SFM-180). A line-by-line port
// of app/services/fta_tikz.py :: picture() and its helpers -- the same geometry, the same number formatting --
// so the standalone's LaTeX export is identical to the app's; tests/browser/test_browser_standalone_fta.py
// compares the two on the same graph. Keep them in step.
(function () {
    'use strict';
    const FTA_UNIT = 1.5;
    const BOX_W = 75.2, BOX_H = 44.0;
    const SYM_X = (BOX_W - 40) / 2, SYM_TOP = 48.0, SYM_W = 40.0, SYM_H = 48.0;
    const LABEL_X = 1.6, LABEL_TOP = 64.0, LABEL_W = 72.0, LABEL_H = 16.0;
    const BLOCK_H = SYM_TOP + SYM_H;
    const BUS = BLOCK_H + 8;
    const OR_TOP_R = 29.6, OR_SIDE_Y = 28.0;
    const OR_BOTTOM_R = 37.658, OR_BOTTOM_RISE = 5.75;
    const TAG_SIZE = 14.0, TAG_W = 22.0, TAG_GAP = 2.0;
    const TRI_TIP = LABEL_TOP - 7;
    const SIDE_Y = SYM_TOP - 2, SIDE_DX = 28.0, SIDE_TRI_H = 12.0, SIDE_TRI_HALF = 7.0;   // transfer-in triangle
    const SCALE = 0.0322, PT_PER_CM = 28.4528, VIEW_U = 1.5;
    const ADDED_FILL = 'yellow!35', FILL = 'blue!15', TITLE_CHARS = 64;
    const RAD_TO_DEG = 180 / Math.PI;
    const OR_TIP_ANGLE = Math.atan2(OR_SIDE_Y, SYM_W / 2 - OR_TOP_R) * RAD_TO_DEG;
    const OR_BOTTOM_CENTRE_Y = SYM_H - OR_BOTTOM_RISE + OR_BOTTOM_R;
    const OR_BOTTOM_ANGLE = Math.atan2(OR_BOTTOM_CENTRE_Y - SYM_H, SYM_W / 2) * RAD_TO_DEG;
    const BUS_FIRST = BLOCK_H + 4, BUS_STEP = 4.0, BUS_SPAN = 22.0;
    const PAGE_W_CM = 26.7, PAGE_H_CM = 13.0;

    // Python's f"{v:.Nf}": like toFixed, but -0.0 keeps its sign
    const fix = (v, n) => (Object.is(v, -0) ? '-' : '') + v.toFixed(n);
    const font = (px, bold = false) => {
        const size = px / VIEW_U * SCALE * PT_PER_CM;
        return `\\fontfamily{phv}\\fontsize{${fix(size, 2)}}{${fix(size * 1.18, 2)}}\\selectfont${bold ? '\\bfseries' : ''}`;
    };
    const TITLE_FONT = font(9), CODE_FONT = font(7.5), TAG_FONT = font(7, true), PAGE_FONT = font(6.5, true);
    const SIDE_FONT = font(5.5, true);                // page number in the small side triangle (SFM-193)

    const ESCAPES = { '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_',
                      '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
    const esc = text => text ? Array.from(String(text).replace(/\n/g, ' ').trim()).map(c => ESCAPES[c] || c).join('') : '';
    const short = (text, limit) => {
        const t = Array.from((text || '').split(/\s+/).filter(Boolean).join(' '));
        return t.length <= limit ? t.join('') : t.slice(0, limit - 1).join('').trimEnd() + '…';
    };
    const pt = (ux, uy) => `(${fix(ux * SCALE, 3)},${fix(-uy * SCALE, 3)})`;
    const cm = units => `${fix(units * SCALE, 3)}cm`;
    const text = (ux, uy, content, size, width) =>
        `\\node[${width ? `text width=${cm(width)}, align=center, ` : ''}inner sep=0pt, font={${size}}] at ${pt(ux, uy)} {${content}};`;
    const breakable = t => esc(t).split('/').join('/\\allowbreak{}');
    // fta_tikz._title(): the lines and size of fta_draw.js :: fitTitle() (= text_fit.fit_title()), SFM-186
    function title(ux, uy, label) {
        const { lines, size } = window.fitTitle(label);
        const px = size * VIEW_U, p = px / VIEW_U * SCALE * PT_PER_CM;
        const f = `\\fontfamily{phv}\\fontsize{${fix(p, 2)}}{${fix(p * 1.18, 2)}}\\selectfont`;
        return text(ux, uy, lines.map(esc).join('\\\\'), f, BOX_W - 4);
    }

    function symbol(sym, sx, sy, fill = FILL) {
        const style = `draw, fill=${fill}`;
        if (sym === 'basic') return [`\\path[${style}] ${pt(sx + SYM_W / 2, sy + SYM_H / 2)} circle[radius=${cm(SYM_H / 2)}];`];
        if (sym === 'and') return [`\\path[${style}] ${pt(sx, sy + SYM_H)} -- ${pt(sx, sy + 20)}`
            + ` arc[start angle=180, end angle=0, radius=${cm(20)}]`
            + ` -- ${pt(sx + SYM_W, sy + SYM_H)} -- cycle;`];
        if (sym === 'triangle' || sym === 'transfer') return [`\\path[${style}] ${pt(sx + SYM_W / 2, sy + TRI_TIP - SYM_TOP)} -- ${pt(sx + SYM_W, sy + SYM_H)}`
            + ` -- ${pt(sx, sy + SYM_H)} -- cycle;`];
        if (sym === 'or') return [`\\path[${style}] ${pt(sx, sy + SYM_H)} -- ${pt(sx, sy + OR_SIDE_Y)}`
            + ` arc[start angle=180, end angle=${fix(OR_TIP_ANGLE, 2)}, radius=${cm(OR_TOP_R)}]`
            + ` arc[start angle=${fix(180 - OR_TIP_ANGLE, 2)}, end angle=0, radius=${cm(OR_TOP_R)}]`
            + ` -- ${pt(sx + SYM_W, sy + SYM_H)}`
            + ` arc[start angle=${fix(OR_BOTTOM_ANGLE, 2)}, end angle=${fix(180 - OR_BOTTOM_ANGLE, 2)},`
            + ` radius=${cm(OR_BOTTOM_R)}] -- cycle;`];
        return [];
    }

    function block(data, cx, cy) {
        const left = cx - BOX_W / 2, top = cy - BLOCK_H / 2;
        const isGate = (data.type || '').endsWith('_gate');
        const fill = data.tikz_fill || (data.added ? ADDED_FILL : FILL);
        let lines = symbol(data.symbol || '', left + SYM_X, top + SYM_TOP, fill);
        if (isGate) return lines;
        const dashed = data.shared ? ', dashed' : '';
        const stubEnd = top + (data.symbol === 'none' ? LABEL_TOP : data.symbol === 'triangle' || data.symbol === 'transfer' ? TRI_TIP : SYM_TOP);
        const side = [];
        if (data.page_start) {                                       // continued from an earlier page
            const sx = cx + SIDE_DX, sy = top + SIDE_Y;
            side.push(`\\draw ${pt(cx, sy)} -- ${pt(sx, sy)};`,
                `\\path[draw, fill=${fill}] ${pt(sx, sy)} -- ${pt(sx + SIDE_TRI_HALF, sy + SIDE_TRI_H)}`
                + ` -- ${pt(sx - SIDE_TRI_HALF, sy + SIDE_TRI_H)} -- cycle;`);
            if (data.from_page) side.push(text(sx, sy + SIDE_TRI_H * 0.68, String(data.from_page), SIDE_FONT));   // SFM-193
        }
        lines = [
            `\\path[draw, fill=${fill}${dashed}] ${pt(left, top)} rectangle ${pt(left + BOX_W, top + BOX_H)};`,
            `\\draw ${pt(cx, top + BOX_H)} -- ${pt(cx, stubEnd)};`,
        ].concat(side, lines, [
            `\\path[draw, fill=${fill}] ${pt(left + LABEL_X, top + LABEL_TOP)}`
            + ` rectangle ${pt(left + LABEL_X + LABEL_W, top + LABEL_TOP + LABEL_H)};`,
            title(cx, top + BOX_H / 2, data.label || ''),
            text(cx, top + LABEL_TOP + LABEL_H / 2, esc(data.code || ''), CODE_FONT),
        ]);
        if (data.symbol === 'transfer' && data.page_number)
            lines.push(text(cx, top + (LABEL_TOP + LABEL_H + BLOCK_H) / 2 + 1, `p.~${data.page_number}`, PAGE_FONT));
        const tag = data.tag || '';
        if (tag) {
            const tagX = left + BOX_W + TAG_GAP, tagY = top + BOX_H / 2 - TAG_SIZE / 2;
            lines.push(`\\path[draw, fill=white] ${pt(tagX, tagY)} rectangle ${pt(tagX + TAG_W, tagY + TAG_SIZE)};`,
                text(tagX + TAG_W / 2, tagY + TAG_SIZE / 2,
                     Array.from(tag).length <= 3 ? esc(tag) : `\\resizebox{${cm(TAG_W - 3)}}{!}{${esc(tag)}}`, TAG_FONT));
        }
        return lines;
    }

    function inputPoint(sym, index, count) {
        if (sym !== 'or' && sym !== 'and') return [BOX_W / 2, LABEL_TOP + LABEL_H];
        const step = count > 1 ? Math.min(13.33, 34 / (count - 1)) : 0.0;
        const dx = (index - (count - 1) / 2) * step;
        if (sym === 'and') return [BOX_W / 2 + dx, BLOCK_H];
        const centreY = SYM_TOP + SYM_H - OR_BOTTOM_RISE + OR_BOTTOM_R;
        return [BOX_W / 2 + dx, centreY - Math.sqrt(OR_BOTTOM_R ** 2 - dx ** 2)];
    }

    function busLevels(nodes, edges) {
        const groups = new Map();
        for (const e of edges) { if (!groups.has(e.source)) groups.set(e.source, []); groups.get(e.source).push(e); }
        const level = {};
        for (const [source, group] of groups) {
            const upper = nodes[source];
            const items = group.map(e => {
                const [px] = inputPoint(upper.data.symbol || '', e.input_index ?? 0, e.input_count ?? 1);
                return [e.id, upper.x - BOX_W / 2 + px, nodes[e.target].x];
            });
            const lefts = items.filter(i => i[2] < i[1] - 0.01).sort((a, b) => a[2] - b[2]);
            const rights = items.filter(i => i[2] > i[1] + 0.01).sort((a, b) => b[2] - a[2]);
            const ranks = Math.max(lefts.length, rights.length);
            const step = ranks > 1 ? Math.min(BUS_STEP, BUS_SPAN / (ranks - 1)) : 0.0;
            for (const [id] of items) level[id] = BUS_FIRST;
            for (const side of [lefts, rights]) side.forEach(([id], k) => { level[id] = BUS_FIRST + k * step; });
        }
        return level;
    }

    function connector(upper, lower, index, count, bus = BUS) {
        const upperLeft = upper.x - BOX_W / 2, upperTop = upper.y - BLOCK_H / 2;
        const lowerTop = lower.y - BLOCK_H / 2;
        const [px, py] = inputPoint(upper.data.symbol || '', index, count);
        const entryY = lowerTop + ((lower.data.type || '').endsWith('_gate') ? SYM_TOP : 0);
        const points = [[upperLeft + px, upperTop + py], [upperLeft + px, upperTop + bus], [lower.x, upperTop + bus], [lower.x, entryY]];
        return '\\draw ' + points.map(([x, y]) => pt(x, y)).join(' -- ') + ';';
    }

    const figure = (body, options = '') => ['\\begin{center}', '\\adjustbox{max width=\\linewidth, max totalheight=0.8\\textheight}{%',
        `\\begin{tikzpicture}[${options}]`, ...body, '\\end{tikzpicture}}', '\\end{center}'];

    // fta_tikz.picture(): the lines of the picture of the tree under `rootId`, [] if it is not in the graph
    function picture(graph, rootId, topNote = '') {
        const nodes = {};
        for (const n of graph.nodes || []) nodes[n.data.id] = { data: n.data, x: n.position.x / FTA_UNIT, y: n.position.y / FTA_UNIT };
        if (!(rootId in nodes)) return [];
        const outEdges = new Map();
        for (const e of graph.edges || []) { if (!outEdges.has(e.data.source)) outEdges.set(e.data.source, []); outEdges.get(e.data.source).push(e.data); }
        const wanted = new Set([rootId]), queue = [rootId];
        let edges = [];
        while (queue.length) {
            for (const e of outEdges.get(queue.shift()) || []) {
                if (e.target in nodes && !wanted.has(e.target)) { wanted.add(e.target); queue.push(e.target); }
                edges.push(e);
            }
        }
        edges = edges.filter(e => wanted.has(e.target));
        const ids = [...wanted];
        const left = Math.min(...ids.map(i => nodes[i].x)) - BOX_W / 2 - TAG_GAP - TAG_W;
        const top = Math.min(...ids.map(i => nodes[i].y)) - BLOCK_H / 2;
        for (const i of ids) { nodes[i].x -= left; nodes[i].y -= top; }

        const body = [];
        const levels = busLevels(nodes, edges);
        for (const e of edges) body.push(connector(nodes[e.source], nodes[e.target], e.input_index ?? 0, e.input_count ?? 1, levels[e.id]));
        for (const i of ids.slice().sort((a, b) => nodes[a].y - nodes[b].y || nodes[a].x - nodes[b].x)) body.push(...block(nodes[i].data, nodes[i].x, nodes[i].y));
        if (topNote) {
            const rx = nodes[rootId].x, ry = nodes[rootId].y;
            const widthCm = (Math.max(...ids.map(i => nodes[i].x)) + BOX_W / 2 + TAG_GAP + TAG_W) * SCALE;
            const heightCm = (Math.max(...ids.map(i => nodes[i].y)) + BLOCK_H / 2) * SCALE;
            const shrink = Math.min(1.0, PAGE_W_CM / widthCm, PAGE_H_CM / heightCm);
            const size = 7 / VIEW_U * SCALE * PT_PER_CM / shrink;
            body.push(`\\node[anchor=south west, inner sep=0pt, text=gray!55] at ${pt(rx - BOX_W / 2, ry - BLOCK_H / 2 - 2)} `
                      + `{\\fontfamily{phv}\\fontsize{${fix(size, 2)}}{${fix(size * 1.2, 2)}}\\selectfont ${topNote}};`);
        }
        return figure(body, 'line width=0.3pt, line cap=round, line join=round');
    }

    // fta_export.export_tex_source() for the standalone: `sheets` = [{number, graph}] (one per page, SFM-184),
    // `ident` = {name, revision, changed, exported, tool}
    function document_(sheets, ident) {
        const tops = sheets.flatMap(s => s.graph.nodes.filter(n => n.data.depth === 0).map(n => ({ ...n, number: s.number, graph: s.graph })));
        const lines = [
            `% Fault trees -- ${ident.name}. Exported by ${ident.tool}, revision ${ident.revision}, ${ident.exported}.`,
            "% Compile with pdflatex. To use a tree in another document: copy the lines between its",
            "% '% ---- tree' comments and add the packages marked 'needed by the trees' to that preamble.",
            '\\documentclass[a4paper,10pt]{article}',
            '\\usepackage[utf8]{inputenc}', '\\usepackage[T1]{fontenc}', '\\usepackage{helvet}',
            '\\renewcommand{\\familydefault}{\\sfdefault}',
            '\\usepackage[a4paper,landscape,margin=1.5cm,footskip=0.8cm]{geometry}',
            '\\usepackage{tikz}            % needed by the trees',
            '\\usetikzlibrary{arrows.meta,fit}',
            '\\usepackage{adjustbox}       % needed by the trees (fits a big tree to the page)',
            '\\usepackage{graphicx}        % needed by the trees',
            '\\usepackage{fancyhdr}', '\\pagestyle{fancy}', '\\fancyhf{}', '\\renewcommand{\\headrulewidth}{0pt}',
            '\\fancyfoot[R]{\\scriptsize \\thepage}',
            '\\begin{document}',
            `\\section*{Fault trees -- ${esc(ident.name)}}`,
            '\\begin{tabular}{@{}ll@{}}',
            `Revision & ${esc(ident.revision)}${ident.changed ? ` (changed ${esc(ident.changed)})` : ''} \\\\`,
            `Exported & ${esc(ident.exported)} \\\\`,
            `Tool & ${esc(ident.tool)} \\\\`,
            '\\end{tabular}',
            '\\par\\bigskip',
        ];
        if (!tops.length) lines.push('No fault tree is recorded.');
        for (const t of tops) {
            const code = t.data.code || t.data.id;
            const heading = t.number > 1 ? `Page ${t.number}: ` : 'Top event ';
            lines.push('\\clearpage', `\\subsection*{${heading}${esc(code)}: ${esc(t.data.label || '')}}`, `% ---- tree ${code} ----`);
            const pic = picture(t.graph, t.data.id, esc(ident.revision));
            lines.push(...(pic.length ? pic : ['This top event has no causes yet.']));
            lines.push(`% ---- end of tree ${code} ----`);
        }
        lines.push('\\end{document}');
        return lines.join('\n') + '\n';
    }

    window.FtaTikz = { picture, document: document_, esc };
})();
