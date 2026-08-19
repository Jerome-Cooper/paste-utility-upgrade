import {parse} from '@tracespace/parser'
import {unzipSync} from 'fflate'

// ---- Tunable constants -----------------------------------------------------
// These are engineering defaults, not measured/calibrated values - they're a
// reasonable starting point and are meant to be tuned once you see real
// dispense results on your machine/paste/nozzle combo.

// A 0402 pad is nominally about 0.6mm x 0.6mm; 30 degrees of auger rotation is
// the known-good dispense for a pad that size, so every other pad size scales
// its dispense degrees off this reference.
export const NOMINAL_0402_PAD_AREA_MM2 = 0.36
export const NOMINAL_0402_DISPENSE_DEGREES = 30
export const MIN_DISPENSE_DEGREES = 3
export const MAX_DISPENSE_DEGREES = 300

// A pad is "elongated" (gets a line of dots instead of one dot) once its
// length:width ratio and absolute length clear both of these. Lowered from an
// earlier 1.2mm floor - IC gull-wing leads (SOIC/TSOP/QFP) are frequently
// shorter than that and were collapsing to a single dot.
export const ELONGATED_ASPECT_RATIO = 2.2
export const ELONGATED_MIN_LENGTH_MM = 0.6

// But below this width, a pad is too "fine" to usefully split into multiple
// dots - the deposits would just merge into each other (or the tip can't
// resolve them at all) - so it stays a single dot no matter how long it is.
export const MIN_LINE_WIDTH_MM = 0.3

// Elongated pads get a bit more total paste than the flat area formula alone
// would give them - a long thin lead needs enough paste along its whole
// length to wet properly, not just "area equivalent" to a square pad.
export const ELONGATED_VOLUME_MULTIPLIER = 1.3

// Spacing between dots along a line/grid, and how far dots stay inset from
// the pad's edge so paste doesn't get squeezed out past the pad.
export const DOT_PITCH_MM = 0.9
export const PAD_EDGE_INSET_MM = 0.15

// A pad this big (e.g. a QFN/thermal power pad) gets a grid of dots instead
// of a single deposit.
export const POWER_PAD_MIN_AREA_MM2 = 4.0

// Pads whose nearest-neighbor edge-to-edge gap is under this are treated as
// fine-pitch (TSOP/QFP-style, i.e. chip ICs sitting in a tight row) - they
// still get their normal point/line/grid pattern (so a long thin pad still
// gets a full line of dots, not just one), but every other pad in the row is
// nudged sideways so consecutive deposits don't sit in one continuous line.
export const TIGHT_PITCH_GAP_MM = 0.35
// Fraction of the pad's half-width to nudge alternating pads by (must stay
// under 1.0 so the dot can't land past the pad edge).
export const STAGGER_OFFSET_FRACTION = 0.85

// Pads within this Y distance of each other are considered the same "row"
// when sorting into a deterministic raster (bottom-to-top, left-to-right).
export const ROW_TOLERANCE_MM = 1.0
// -----------------------------------------------------------------------------

// Accepts a FileList/array. If it's a single .zip, unzips it (typical fab
// output bundle from KiCad/JLCPCB/EasyEDA); otherwise treats every selected
// file as a loose gerber.
export async function expandFileSelection(fileList) {
    const files = Array.from(fileList)

    if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
        const buffer = new Uint8Array(await files[0].arrayBuffer())
        const entries = unzipSync(buffer)

        return Object.entries(entries)
            .filter(([name, data]) => !name.endsWith('/') && data.length > 0)
            .map(([name, data]) => ({
                name: name.split('/').pop(),
                text: new TextDecoder().decode(data)
            }))
    }

    return Promise.all(files.map(async file => ({name: file.name, text: await file.text()})))
}

// KiCad, Altium, and EasyEDA all emit the Gerber X2 %TF.FileFunction% attribute
// on modern exports, so we can identify a layer from its own content instead of
// guessing per-vendor filename conventions. Falls back to filename heuristics
// for older exports that don't include it.
function classifyFile(name, tree) {
    let fileFunction = null

    for (const child of tree.children) {
        // Standalone %TF.FileFunction,...*% attributes come through as 'unimplemented'
        // nodes, but Altium (and some other tools) instead embed the same attribute in
        // an X1-compatible extended comment - `G04 #@! TF.FileFunction,...*` - which the
        // parser reports as a plain 'comment' node. Check both.
        if (child.type === 'unimplemented' && typeof child.value === 'string' && child.value.includes('TF.FileFunction')) {
            fileFunction = child.value
            break
        }
        if (child.type === 'comment' && typeof child.comment === 'string' && child.comment.includes('TF.FileFunction')) {
            fileFunction = child.comment
            break
        }
    }

    if (fileFunction) {
        const isBottom = /,\s*Bot(tom)?\b/i.test(fileFunction)
        if (/FileFunction,\s*Paste/i.test(fileFunction)) return {kind: 'paste', side: isBottom ? 'bottom' : 'top'}
        if (/FileFunction,\s*Soldermask/i.test(fileFunction)) return {kind: 'mask', side: isBottom ? 'bottom' : 'top'}
        return {kind: 'other', side: null}
    }

    const lower = name.toLowerCase()
    const isBottom = /(^|[^a-z])(bot|bottom)([^a-z]|$)/.test(lower) || /\.(gbp|gbs)$/.test(lower)

    if (lower.includes('paste') || /\.gtp$/.test(lower) || /\.gbp$/.test(lower)) {
        return {kind: 'paste', side: isBottom ? 'bottom' : 'top'}
    }
    if (lower.includes('mask') || /\.gts$/.test(lower) || /\.gbs$/.test(lower)) {
        return {kind: 'mask', side: isBottom ? 'bottom' : 'top'}
    }

    return {kind: 'other', side: null}
}

// Resolves a macro primitive parameter, which may be a literal number, a
// variable reference ($1, $2, ...) filled in from the aperture's ADD command,
// or an arithmetic expression combining either.
function evalMacroValue(value, variableValues) {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
        const match = /^\$(\d+)$/.exec(value)
        return match ? (variableValues[Number(match[1]) - 1] ?? 0) : 0
    }
    if (value && typeof value === 'object' && 'operator' in value) {
        const left = evalMacroValue(value.left, variableValues)
        const right = evalMacroValue(value.right, variableValues)
        switch (value.operator) {
            case '+': return left + right
            case '-': return left - right
            case 'x': return left * right
            case '/': return left / right
        }
    }
    return 0
}

function rotatedRectBounds(cx, cy, w, h, rotationDeg) {
    const rad = (rotationDeg || 0) * Math.PI / 180
    const hw = w / 2, hh = h / 2
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
        const rx = cx + x * Math.cos(rad) - y * Math.sin(rad)
        const ry = cy + x * Math.sin(rad) + y * Math.cos(rad)
        minX = Math.min(minX, rx); maxX = Math.max(maxX, rx)
        minY = Math.min(minY, ry); maxY = Math.max(maxY, ry)
    }
    return {minX, minY, maxX, maxY}
}

// Computes the overall (axis-aligned) bounding box of a macro aperture by
// unioning the bounds of its primitives - circles, center-line rects, and
// vector lines, which covers the vast majority of real pad macros (e.g.
// Altium's rounded-rectangle pads). Outline/polygon/moire/thermal primitives
// aren't modeled; if the macro is built entirely from those, this returns
// null and the caller falls back to a nominal dot rather than guessing wrong.
function macroShapeBounds(macroChildren, variableValues) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    let found = false

    for (const prim of macroChildren) {
        if (prim.type !== 'macroPrimitive') continue
        const p = prim.parameters.map(v => evalMacroValue(v, variableValues))
        let bounds = null

        if (prim.code === '1') {
            // circle: exposure, diameter, centerX, centerY
            const [, diameter, cx = 0, cy = 0] = p
            const r = diameter / 2
            bounds = {minX: cx - r, maxX: cx + r, minY: cy - r, maxY: cy + r}
        } else if (prim.code === '21') {
            // center line: exposure, width, height, centerX, centerY, rotation
            const [, width, height, cx = 0, cy = 0, rotation = 0] = p
            bounds = rotatedRectBounds(cx, cy, width, height, rotation)
        } else if (prim.code === '20' || prim.code === '2') {
            // vector line: exposure, width, startX, startY, endX, endY, rotation
            const [, width, x1, y1, x2, y2, rotation = 0] = p
            const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2
            const length = Math.hypot(x2 - x1, y2 - y1)
            const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI
            bounds = rotatedRectBounds(cx, cy, length, width, angle + rotation)
        }

        if (bounds) {
            minX = Math.min(minX, bounds.minX); maxX = Math.max(maxX, bounds.maxX)
            minY = Math.min(minY, bounds.minY); maxY = Math.max(maxY, bounds.maxY)
            found = true
        }
    }

    return found ? {xSize: maxX - minX, ySize: maxY - minY} : null
}

// Turns a tool (aperture) definition into pad geometry in mm, including an
// approximate area used for dispense-volume scaling.
function padFromTool(x, y, tool, macros) {
    if (!tool) {
        // A flash before any tool was selected means a malformed file - fall
        // back to a nominal small pad rather than losing the point.
        return {x, y, shape: 'unknown', xSize: 0.3, ySize: 0.3, diameter: 0.3, area: NOMINAL_0402_PAD_AREA_MM2}
    }

    if (tool.type === 'circle') {
        const d = tool.diameter
        return {x, y, shape: 'circle', xSize: d, ySize: d, diameter: d, area: Math.PI * (d / 2) ** 2}
    }

    if (tool.type === 'rectangle') {
        const {xSize, ySize} = tool
        return {x, y, shape: 'rectangle', xSize, ySize, diameter: null, area: xSize * ySize}
    }

    if (tool.type === 'obround') {
        const {xSize, ySize} = tool
        const r = Math.min(xSize, ySize) / 2
        // Stadium shape: rectangle area minus the square the rounded ends replace, plus the circle they form.
        const area = xSize * ySize - (2 * r) ** 2 + Math.PI * r ** 2
        return {x, y, shape: 'obround', xSize, ySize, diameter: null, area}
    }

    if (tool.type === 'polygon') {
        const d = tool.diameter
        return {x, y, shape: 'polygon', xSize: d, ySize: d, diameter: d, area: Math.PI * (d / 2) ** 2}
    }

    if (tool.type === 'macroShape') {
        const macroChildren = macros?.get(tool.name)
        const bounds = macroChildren ? macroShapeBounds(macroChildren, tool.variableValues || []) : null
        if (bounds && bounds.xSize > 0 && bounds.ySize > 0) {
            const {xSize, ySize} = bounds
            return {x, y, shape: 'rectangle', xSize, ySize, diameter: null, area: xSize * ySize}
        }
    }

    // Anything else we don't model (or a macro shape we couldn't resolve): we
    // don't know its true silhouette, so treat it as a nominal dot rather than
    // guessing wrong.
    return {x, y, shape: 'unknown', xSize: 0.3, ySize: 0.3, diameter: 0.3, area: NOMINAL_0402_PAD_AREA_MM2}
}

// Walks a parsed gerber tree, linking each flash (D03) to its active aperture
// so we get real pad geometry, not just bare center points.
function extractPads(tree) {
    let decimalScale = 1000000
    let unitScale = 1
    let lastX = NaN
    let lastY = NaN
    const tools = new Map()
    const macros = new Map()
    let activeTool = null
    const pads = []

    for (const child of tree.children) {
        if (child.type === 'units') {
            unitScale = child.units === 'in' ? 25.4 : 1
        } else if (child.type === 'coordinateFormat') {
            if (child.format) decimalScale = Math.pow(10, child.format[1])
        } else if (child.type === 'toolMacro') {
            macros.set(child.name, child.children)
        } else if (child.type === 'toolDefinition') {
            tools.set(child.code, child.shape)
        } else if (child.type === 'toolChange') {
            activeTool = tools.get(child.code) || null
        } else if (child.type === 'graphic') {
            // Gerber coordinates are modal across every graphic op, not just flashes -
            // e.g. Altium commonly writes a separate move (D02) that sets position,
            // then a flash (D03) with no coordinates of its own that inherits it. Track
            // the running position from moves/segments too, or flashes like that would
            // never resolve to a real point.
            const rawX = child.coordinates.x !== undefined ? Number(child.coordinates.x) : NaN
            const rawY = child.coordinates.y !== undefined ? Number(child.coordinates.y) : NaN

            const resolvedX = Number.isNaN(rawX) ? lastX : rawX
            const resolvedY = Number.isNaN(rawY) ? lastY : rawY

            if (!Number.isNaN(rawX)) lastX = rawX
            if (!Number.isNaN(rawY)) lastY = rawY

            if (child.graphic === 'shape') {
                if (Number.isNaN(resolvedX) || Number.isNaN(resolvedY)) continue

                const x = resolvedX / decimalScale * unitScale
                const y = resolvedY / decimalScale * unitScale

                pads.push(padFromTool(x, y, activeTool, macros))
            }
        }
    }

    return pads
}

// Reads the selected file(s), classifies each one, and returns the paste pad
// geometry plus raw mask flash points (used to spot fiducial candidates).
export async function importGerberSet(fileList) {
    const files = await expandFileSelection(fileList)
    const warnings = []
    const detected = []

    let pastePads = null
    let pasteSide = null
    let maskFlashes = null
    let maskSide = null

    for (const file of files) {
        if (/\.(drl|xln|txt|pdf|csv|md|zip)$/i.test(file.name)) continue

        // A full fab-output zip includes copper/silkscreen/drill/outline layers too,
        // and those can be large (dense routing, lots of arcs/regions). Fully parsing
        // every file in the bundle to find the one or two we care about is what was
        // freezing the tab on a real multi-layer board. Do a cheap raw-text/filename
        // check first and only run the real (expensive) parser on files that could
        // plausibly be a paste or mask layer.
        const looksRelevant =
            /FileFunction,\s*(Paste|Soldermask)/i.test(file.text) ||
            /paste|mask/i.test(file.name) ||
            /\.(gtp|gbp|gts|gbs)$/i.test(file.name)

        if (!looksRelevant) continue

        // Yield to the browser between files so the tab can repaint/stay responsive
        // instead of blocking the main thread through the whole import.
        await new Promise(resolve => setTimeout(resolve, 0))

        let tree
        try {
            tree = parse(file.text)
        } catch (error) {
            warnings.push(`Could not parse ${file.name}: ${error.message}`)
            continue
        }

        if (tree.filetype !== 'gerber') continue

        const {kind, side} = classifyFile(file.name, tree)
        if (kind !== 'other') detected.push(`${file.name} -> ${kind}${side ? ' (' + side + ')' : ''}`)

        if (kind === 'paste' && (pastePads === null || (pasteSide === 'bottom' && side === 'top'))) {
            pastePads = extractPads(tree)
            pasteSide = side
        } else if (kind === 'mask' && (maskFlashes === null || (maskSide === 'bottom' && side === 'top'))) {
            maskFlashes = extractPads(tree).map(p => ({x: p.x, y: p.y}))
            maskSide = side
        }
    }

    if (!pastePads) {
        throw new Error(
            "Couldn't find a paste layer in the selected file(s). " +
            (detected.length ? `Detected: ${detected.join(', ')}. ` : '') +
            'Make sure the solder paste gerber (e.g. *-F_Paste.gbr / *.GTP) is included.'
        )
    }

    if (!maskFlashes) {
        warnings.push('No solder mask layer detected - skipping automatic fiducial candidate detection.')
        maskFlashes = []
    }

    return {pastePads, maskFlashes, warnings, detected}
}

function padLength(pad) {
    if (pad.shape === 'rectangle' || pad.shape === 'obround') return Math.max(pad.xSize, pad.ySize)
    return pad.diameter ?? Math.max(pad.xSize, pad.ySize)
}

function padWidth(pad) {
    if (pad.shape === 'rectangle' || pad.shape === 'obround') return Math.min(pad.xSize, pad.ySize)
    return pad.diameter ?? Math.min(pad.xSize, pad.ySize)
}

function padLongAxisIsX(pad) {
    return pad.xSize >= pad.ySize
}

function classifyPad(pad) {
    const length = padLength(pad)
    const width = padWidth(pad)
    const aspect = width > 0 ? length / width : 1

    if ((pad.shape === 'rectangle' || pad.shape === 'obround') &&
        aspect >= ELONGATED_ASPECT_RATIO && length >= ELONGATED_MIN_LENGTH_MM &&
        width >= MIN_LINE_WIDTH_MM) {
        return 'line'
    }

    if (pad.area >= POWER_PAD_MIN_AREA_MM2) return 'grid'

    return 'point'
}

function totalDispenseDegreesForPad(pad, baseDispenseDegrees, kind) {
    let raw = baseDispenseDegrees * (pad.area / NOMINAL_0402_PAD_AREA_MM2)
    if (kind === 'line') raw *= ELONGATED_VOLUME_MULTIPLIER
    return Math.min(MAX_DISPENSE_DEGREES, Math.max(MIN_DISPENSE_DEGREES, raw))
}

// Returns dispense sub-points as {dx, dy, dispenseDegrees} offsets (mm) from
// the pad center, splitting the pad's total (area-scaled) dispense volume
// across however many dots the pattern needs.
export function planPadDispense(pad, baseDispenseDegrees, staggerSign = 0) {
    const kind = classifyPad(pad)
    const total = totalDispenseDegreesForPad(pad, baseDispenseDegrees, kind)
    const alongX = padLongAxisIsX(pad)

    let points

    if (kind === 'line') {
        const length = padLength(pad)
        const usable = Math.max(length - 2 * PAD_EDGE_INSET_MM, 0.1)
        const dotCount = Math.max(2, Math.round(usable / DOT_PITCH_MM) + 1)
        const spacing = dotCount > 1 ? usable / (dotCount - 1) : 0

        points = []
        for (let i = 0; i < dotCount; i++) {
            const offset = -usable / 2 + i * spacing
            points.push({
                dx: alongX ? offset : 0,
                dy: alongX ? 0 : offset,
                dispenseDegrees: Math.max(MIN_DISPENSE_DEGREES, total / dotCount)
            })
        }
    } else if (kind === 'grid') {
        const usableX = Math.max(pad.xSize - 2 * PAD_EDGE_INSET_MM, 0.1)
        const usableY = Math.max(pad.ySize - 2 * PAD_EDGE_INSET_MM, 0.1)
        const cols = Math.max(2, Math.round(usableX / DOT_PITCH_MM) + 1)
        const rows = Math.max(2, Math.round(usableY / DOT_PITCH_MM) + 1)
        const stepX = cols > 1 ? usableX / (cols - 1) : 0
        const stepY = rows > 1 ? usableY / (rows - 1) : 0
        const dotCount = cols * rows

        points = []
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                points.push({
                    dx: -usableX / 2 + c * stepX,
                    dy: -usableY / 2 + r * stepY,
                    dispenseDegrees: Math.max(MIN_DISPENSE_DEGREES, total / dotCount)
                })
            }
        }
    } else {
        points = [{dx: 0, dy: 0, dispenseDegrees: total}]
    }

    if (pad.tightPitch && staggerSign !== 0) {
        // Nudge the whole pattern (not just a lone dot) perpendicular to the
        // pad's long axis, alternating direction pad-to-pad, so a row of
        // closely spaced IC leads doesn't dispense as one continuous line.
        const offset = (padWidth(pad) / 2) * STAGGER_OFFSET_FRACTION * staggerSign
        points = points.map(p => ({
            ...p,
            dx: p.dx + (alongX ? 0 : offset),
            dy: p.dy + (alongX ? offset : 0)
        }))
    }

    return points
}

// Deterministic bottom-to-top, left-to-right scan order (rows grouped by Y
// within a tolerance, sorted by X within each row) instead of whatever order
// the gerber happens to list flashes in.
export function sortPadsRasterOrder(pads, rowToleranceMm = ROW_TOLERANCE_MM) {
    const byY = [...pads].sort((a, b) => a.y - b.y || a.x - b.x)
    const rows = []

    for (const pad of byY) {
        const row = rows.find(r => Math.abs(r.y - pad.y) <= rowToleranceMm)
        if (row) {
            row.y = (row.y * row.pads.length + pad.y) / (row.pads.length + 1)
            row.pads.push(pad)
        } else {
            rows.push({y: pad.y, pads: [pad]})
        }
    }

    rows.sort((a, b) => a.y - b.y)

    const result = []
    for (const row of rows) {
        row.pads.sort((a, b) => a.x - b.x)
        result.push(...row.pads)
    }
    return result
}

function isTightNeighbor(padA, padB, gapThreshold) {
    const halfAX = (padA.xSize ?? padA.diameter ?? 0.3) / 2
    const halfAY = (padA.ySize ?? padA.diameter ?? 0.3) / 2
    const halfBX = (padB.xSize ?? padB.diameter ?? 0.3) / 2
    const halfBY = (padB.ySize ?? padB.diameter ?? 0.3) / 2

    const dxGap = Math.abs(padA.x - padB.x) - (halfAX + halfBX)
    const dyGap = Math.abs(padA.y - padB.y) - (halfAY + halfBY)

    // Close on one axis while roughly aligned on the other = neighbors in a row/column.
    const rowNeighbors = dyGap < 0 && dxGap >= 0 && dxGap < gapThreshold
    const colNeighbors = dxGap < 0 && dyGap >= 0 && dyGap < gapThreshold

    return rowNeighbors || colNeighbors
}

// Flags pads (TSOP/QFP-style fine pitch) whose nearest-neighbor gap is under
// the threshold, so planPadDispense() can fall back to a single staggered dot.
export function tagTightPitchPads(pads, gapThreshold = TIGHT_PITCH_GAP_MM) {
    return pads.map((pad, i) => ({
        ...pad,
        tightPitch: pads.some((other, j) => j !== i && isTightNeighbor(pad, other, gapThreshold))
    }))
}
