'use strict';

/*
 * NOX Modbus server, from the NOX wiki page "Modbus Server" (NOX System >= V8.60):
 * - area N = register N (1-999), 16 bit: bits 0-9 area state, 10-13 why the last setting failed
 *   (cleared after one read), 14 active alarms, 15 area is used
 * - inputs: since R9 NOX input n = register 10000 + n - 1, else by module ID (bus 1-3: ID 1000-3999)
 *   * 10 + input; bit 0 open/movement, 1 sabotage, 2 deactivated, 3 alarm, 4 open2 (>= 9.71),
 *   15 detector is used; writing: bit 7 deactivate, bit 6 acknowledge (mask write)
 * - register 1000 = 1: acknowledge all alarms
 * - NOX THS/THT: ID*10 + 1..8, temperature 0-2000 = 0-200 °C, > 2000 = minus (value - 2000)
 * Area states: version 1 = one bit per state (bits 0-9), version 2 (>= 9.71) = number in bits 0-9.
 */

const AREA_STATES = {
    0: 'Unbekannt',
    1: 'Unscharf',
    2: 'Unscharf – Ausgangsverzögerung',
    3: 'Unscharf – Ausgang wartet',
    4: 'Unscharf – Eingangsverzögerung',
    5: 'Scharf',
    6: 'Teilscharf',
    7: 'Benutzerdefiniert',
};

const AREA_ERRORS = [
    [10, 'Bereich ist in der Sperrzeit'],
    [11, 'keine Berechtigung'],
    [12, 'aktive Melder im Bereich'],
    [13, 'aktive Alarme im Bereich'],
];

const ACK_ALL = 1000;
const USED = 0x8000;

/** register number list from text like "1-32" or "10000-10199, 20011-20018" */
function parseRanges(text, max = 4000) {
    const out = new Set();
    for (const part of String(text || '').split(/[,;\s]+/).filter(Boolean)) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!m) {
            throw new Error(`Bereich „${part}“ nicht verständlich (Beispiel: 10000-10199)`);
        }
        const from = Number(m[1]);
        const to = m[2] ? Number(m[2]) : from;
        if (to < from || to > 65535) {
            throw new Error(`Bereich „${part}“ ungültig`);
        }
        for (let n = from; n <= to; n++) {
            out.add(n);
            if (out.size > max) {
                throw new Error(`Zu viele Register (höchstens ${max})`);
            }
        }
    }
    return [...out].sort((a, b) => a - b);
}

/** registers -> reads of up to `max` registers, gaps up to `gap` are read along */
function blocks(regs, max = 100, gap = 8) {
    const out = [];
    for (const r of [...regs].sort((a, b) => a - b)) {
        const last = out[out.length - 1];
        if (last && r - (last.addr + last.count) <= gap && r - last.addr < max) {
            last.count = r - last.addr + 1;
        } else {
            out.push({ addr: r, count: 1 });
        }
    }
    return out;
}

const swap = v => ((v & 0xff) << 8) | (v >> 8);

/**
 * Byte order from scanned values: a used register has bit 15 set; with swapped bytes it shows up as bit 7 instead
 * (an input in rest = 128, open = 384). Returns 'be', 'le' or null (not decidable).
 */
function detectOrder(values) {
    let be = 0;
    let le = 0;
    for (const v of values) {
        if (v & USED && !(v & 0x80)) {
            be++;
        } else if (v & 0x80 && !(v & USED)) {
            le++;
        }
    }
    return be > le ? 'be' : le > be ? 'le' : null;
}

/** area state code from bits 0-9 */
function areaCode(bits, version) {
    if (version === 2) {
        return bits <= 6 ? bits : 7;
    }
    if (!bits || bits & (bits - 1)) {
        return 0; // version 1: exactly one bit
    }
    const n = Math.log2(bits);
    return n <= 6 ? n : 7;
}

/**
 * Version from the area values seen (bits 0-9): 3/5/6 or 1 only exist as numbers (version 2), single bits above 4 or
 * a "disarmed" 2 mean version 1. null = not decidable yet.
 */
function detectVersion(list) {
    const vals = list.map(v => v & 0x3ff).filter(Boolean);
    if (vals.some(v => [3, 5, 6].includes(v))) {
        return 2;
    }
    if (vals.some(v => v >= 8)) {
        return 1;
    }
    if (vals.includes(1)) {
        return 2;
    }
    if (vals.includes(2)) {
        return 1;
    }
    return null;
}

function parseArea(v, version) {
    const code = areaCode(v & 0x3ff, version);
    return {
        used: Boolean(v & USED),
        code,
        text: AREA_STATES[code] || `Unbekannt (${v & 0x3ff})`,
        armed: code === 5 || code === 6,
        alarm: Boolean(v & 0x4000),
        errors: AREA_ERRORS.filter(([bit]) => v & (1 << bit)).map(([, t]) => t),
    };
}

function parseInput(v) {
    return {
        used: Boolean(v & USED),
        open: Boolean(v & 1),
        sabotage: Boolean(v & 2),
        deactivated: Boolean(v & 4),
        alarm: Boolean(v & 8),
        open2: Boolean(v & 16),
    };
}

/** NOX THS / THT temperature register -> °C */
function temperature(v) {
    return v > 2000 ? -(v - 2000) / 10 : v / 10;
}

/** registers of a NOX THS / THT with this ID: [offset, key] */
const CLIMATE = {
    ths: [[1, 'fault'], [2, 'tempAlarm'], [3, 'humAlarm'], [5, 'open'], [6, 'missing'], [7, 'temperature'], [8, 'humidity']],
    tht: [[1, 'tempAlarm'], [2, 'humAlarm'], [6, 'missing'], [7, 'temperature'], [8, 'humidity']],
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** name from the export's "{01…}{02Name¦Zusatz}…" (02 = German), "¦" becomes a space */
function exportName(text) {
    const parts = [...String(text || '').matchAll(/\{(\d\d)([^}]*)\}/g)];
    const de = parts.find(p => p[1] === '02') || parts[0];
    const raw = de ? de[2] : String(text || '');
    return raw
        .replace(/&(\w+);/g, (m, e) => ENTITIES[e] || m)
        .replace(/¦/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * NOX export list (CSV "UnitType;InputOutput;ID;Name;Area;InputProfile"): every input row (I1, I2, …) in the order of
 * the list is the next NOX input; register = 10000 + running number (checked against the owner's working modbus
 * setup: 12 of 12 detectors matched). Returns the inputs that have a name or an area: [{reg, name, area, unit}].
 */
function parseExport(text) {
    const out = [];
    let n = 0;
    let unit = '';
    for (const line of String(text || '').split(/\r?\n/)) {
        // "&gt;" in a name would otherwise split the row
        const f = line.replace(/&(\w+);/g, (m, e) => ENTITIES[e] || m).split(';');
        if (f.length < 4 || f[0] === 'UnitType') {
            continue;
        }
        if (f[0]) {
            unit = exportName(f[3]) || f[2];
            continue;
        }
        if (!/^I\d+$/.test(f[1])) {
            continue;
        }
        n++;
        const name = exportName(f[3]);
        const area = Number(f[4]) || 0;
        if (name || area) {
            out.push({ reg: 10000 + n, name, area, unit, id: f[2], profile: Number(f[5]) || 0 });
        }
    }
    return out;
}

module.exports = { parseExport, exportName, AREA_STATES, ACK_ALL, USED, parseRanges, blocks, swap, detectOrder, detectVersion, areaCode, parseArea, parseInput, temperature, CLIMATE };
