'use strict';

const utils = require('@iobroker/adapter-core');
const { ModbusClient, ModbusError } = require('./lib/modbus');
const N = require('./lib/nox');

const ro = (name, type, role, extra = {}) => ({ type: 'state', common: { name, type, role, read: true, write: false, ...extra }, native: {} });
const rw = (name, type, role, extra = {}) => ({ type: 'state', common: { name, type, role, read: true, write: true, ...extra }, native: {} });

const SET_STATES = { 1: 'Unscharf', 2: 'Unscharf – Ausgangsverzögerung', 3: 'Unscharf – Ausgang wartet', 4: 'Unscharf – Eingangsverzögerung', 5: 'Scharf' };

class Nox extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'nox_alarmzentrale' });
        this.last = new Map(); // state id -> last value written
        this.order = null; // 'be' | 'le'
        this.version = null; // area state version 1 | 2
        this.areas = []; // used area numbers
        this.inputs = []; // used input registers
        this.missing = new Set(); // registers the NOX refuses
        this.areaErrors = new Map(); // area -> text of the last failed setting
        this.failures = 0;
        this.lastError = '';
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    get interval() {
        return Number(this.config.pollMs) || Math.max(0.5, Number(this.config.interval) || 1) * 1000; // pollMs: tests only
    }

    get control() {
        return Boolean(this.config.allowControl);
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        const host = String(this.config.host || '').trim();
        if (!host) {
            this.log.error('Adresse der NOX fehlt (Instanz-Einstellungen)');
            return;
        }
        try {
            this.areaRegs = N.parseRanges(this.config.areas || '1-16').filter(n => n >= 1 && n <= 999);
            this.inputRegs = N.parseRanges(this.config.inputs || '10000-10127');
        } catch (err) {
            this.log.error(`Einstellungen: ${err.message}`);
            return;
        }
        this.names = new Map();
        await this.importModbus();
        for (const row of Array.isArray(this.config.names) ? this.config.names : []) {
            const nr = Number(row && row.nr);
            if (Number.isInteger(nr) && String(row.name || '').trim()) {
                this.names.set(`${row.kind === 'area' ? 'area' : 'input'}:${nr}`, String(row.name).trim());
            }
        }
        this.climate = (Array.isArray(this.config.climate) ? this.config.climate : [])
            .map(c => ({ id: Number(c && c.id), kind: c && c.kind === 'tht' ? 'tht' : 'ths', name: String((c && c.name) || '').trim() }))
            .filter(c => Number.isInteger(c.id) && c.id > 0 && c.id < 6500);
        this.order = ['be', 'le'].includes(this.config.byteOrder) ? this.config.byteOrder : null;
        this.version = ['1', '2'].includes(String(this.config.areaVersion)) ? Number(this.config.areaVersion) : null;
        this.offset = Number(this.config.offset) || 0;

        await this.extendObject('info.areaVersion', ro('Version der Bereichszustände', 'number', 'value', { states: { 1: 'Version 1 (Bits)', 2: 'Version 2 (Zahl)' } }));
        await this.extendObject('info.byteOrder', ro('Byte-Reihenfolge', 'string', 'text'));
        await this.extendObject('info.areas', ro('Gefundene Bereiche', 'number', 'value'));
        await this.extendObject('info.inputs', ro('Gefundene Melder', 'number', 'value'));
        if (this.control) {
            await this.extendObject('control', { type: 'channel', common: { name: 'Steuerung' }, native: {} });
            await this.extendObject('control.ackAll', rw('Alle Alarme quittieren', 'boolean', 'button', { def: false }));
        }

        this.mb = new ModbusClient({ host, port: Number(this.config.port) || 502, unitId: this.config.unitId === undefined || this.config.unitId === '' ? 1 : Number(this.config.unitId), timeout: Math.max(2, Number(this.config.timeout) || 5) * 1000 });
        this.mb.on('connect', () => {
            this.log.info(`Verbunden mit ${host}`);
            this.scanned = false; // after a reconnect the list is read again (units may have changed)
        });
        this.mb.on('disconnect', err => this.log.debug(`Verbindung getrennt: ${err.message}`));
        this.subscribeStates('areas.*');
        this.subscribeStates('inputs.*');
        this.subscribeStates('control.*');
        this.poll();
    }

    /**
     * Names and registers from an instance of the generic modbus adapter that already reads the NOX (its holding and
     * input registers: address + name), so nothing has to be typed again. Own names in the table win.
     */
    async importModbus() {
        const inst = String(this.config.modbusImport || '').trim();
        if (!inst) {
            return;
        }
        if (!/^modbus\.\d+$/.test(inst)) {
            this.log.warn(`Übernahme: „${inst}“ ist keine modbus-Instanz (Beispiel: modbus.0)`);
            return;
        }
        const obj = await this.getForeignObjectAsync(`system.adapter.${inst}`).catch(() => null);
        const native = (obj && obj.native) || {};
        const rows = [...(Array.isArray(native.holdingRegs) ? native.holdingRegs : []), ...(Array.isArray(native.inputRegs) ? native.inputRegs : [])];
        let areas = 0;
        let inputs = 0;
        for (const r of rows) {
            const addr = Number(r && (r._address !== undefined ? r._address : r.address));
            const name = String((r && (r.name || r.description)) || '').trim();
            if (!Number.isInteger(addr) || addr < 1 || addr > 65535 || addr === N.ACK_ALL) {
                continue;
            }
            if (addr <= 999) {
                if (!this.areaRegs.includes(addr)) {
                    this.areaRegs.push(addr);
                }
                if (name) {
                    this.names.set(`area:${addr}`, name);
                }
                areas++;
            } else {
                if (!this.inputRegs.includes(addr)) {
                    this.inputRegs.push(addr);
                }
                if (name) {
                    this.names.set(`input:${addr}`, name);
                }
                inputs++;
            }
        }
        this.areaRegs.sort((a, b) => a - b);
        this.inputRegs.sort((a, b) => a - b);
        if (!obj) {
            this.log.warn(`Übernahme: Instanz ${inst} nicht gefunden`);
        } else {
            this.log.info(`Übernommen aus ${inst}: ${areas} Bereich(e), ${inputs} Melder mit Namen`);
        }
    }

    fix(v) {
        return this.order === 'le' ? N.swap(v) : v;
    }

    /** reads registers (number list) -> Map register -> raw value; registers the NOX refuses are skipped for good */
    async readRegs(list) {
        const out = new Map();
        const read = async (addr, count) => {
            try {
                const vals = await this.mb.read(addr + this.offset, count);
                vals.forEach((v, i) => out.set(addr + i, v));
            } catch (err) {
                if (!(err instanceof ModbusError && err.code === 2)) {
                    throw err;
                }
                if (count === 1) {
                    if (!this.missing.has(addr)) {
                        this.missing.add(addr);
                        this.log.debug(`Register ${addr} gibt die NOX nicht her`);
                    }
                    return;
                }
                const half = Math.ceil(count / 2);
                await read(addr, half);
                await read(addr + half, count - half);
            }
        };
        for (const b of N.blocks(list.filter(r => !this.missing.has(r)))) {
            await read(b.addr, b.count);
        }
        return out;
    }

    /** which areas and detectors the NOX uses (bit 15), byte order and area version */
    async scan() {
        const raw = await this.readRegs([...this.areaRegs, ...this.inputRegs]);
        if (!this.order) {
            this.order = N.detectOrder([...raw.values()]) || 'be';
            this.log.info(`Byte-Reihenfolge: ${this.order === 'le' ? 'vertauscht (Low-Byte zuerst)' : 'Standard (High-Byte zuerst)'}`);
        }
        await this.put('info.byteOrder', this.order === 'le' ? 'vertauscht' : 'Standard');
        const used = r => raw.has(r) && Boolean(this.fix(raw.get(r)) & N.USED);
        this.areas = this.areaRegs.filter(used);
        this.inputs = this.inputRegs.filter(used);
        if (!this.areas.length && !this.inputs.length) {
            this.log.warn('Keine Bereiche und Melder gefunden – Registerbereiche und Adressversatz in den Einstellungen prüfen');
        } else {
            this.log.info(`NOX: ${this.areas.length} Bereich(e), ${this.inputs.length} Melder`);
        }
        await this.put('info.areas', this.areas.length);
        await this.put('info.inputs', this.inputs.length);
        for (const a of this.areas) {
            await this.createArea(a);
        }
        for (const r of this.inputs) {
            await this.createInput(r);
        }
        for (const c of this.climate) {
            await this.createClimate(c);
        }
        this.scanned = true;
    }

    async createArea(a) {
        const p = `areas.${a}`;
        await this.extendObject('areas', { type: 'folder', common: { name: 'Bereiche' }, native: {} });
        await this.extendObject(p, { type: 'channel', common: { name: this.names.get(`area:${a}`) || `Bereich ${a}` }, native: { register: a } });
        await this.extendObject(`${p}.state`, ro('Zustand', 'number', 'value', { states: N.AREA_STATES }));
        await this.extendObject(`${p}.text`, ro('Zustand (Text)', 'string', 'text'));
        await this.extendObject(`${p}.armed`, this.control ? rw('Scharf (true = scharf, false = unscharf)', 'boolean', 'switch') : ro('Scharf', 'boolean', 'indicator'));
        await this.extendObject(`${p}.alarm`, ro('Aktive Alarme', 'boolean', 'indicator.alarm'));
        await this.extendObject(`${p}.error`, ro('Letzte Schaltung fehlgeschlagen', 'string', 'text'));
        await this.extendObject(`${p}.raw`, ro('Registerwert', 'number', 'value'));
        if (this.control) {
            await this.extendObject(`${p}.setState`, rw('Zustand setzen (1-5)', 'number', 'level', { states: SET_STATES, min: 1, max: 5 }));
        }
    }

    async createInput(r) {
        const p = `inputs.${r}`;
        await this.extendObject('inputs', { type: 'folder', common: { name: 'Melder' }, native: {} });
        await this.extendObject(p, { type: 'channel', common: { name: this.names.get(`input:${r}`) || `Melder ${r}` }, native: { register: r } });
        await this.extendObject(`${p}.open`, ro('Offen / Bewegung', 'boolean', 'sensor'));
        await this.extendObject(`${p}.sabotage`, ro('Sabotage', 'boolean', 'indicator.alarm'));
        await this.extendObject(`${p}.deactivated`, this.control ? rw('Abgeschaltet', 'boolean', 'switch') : ro('Abgeschaltet', 'boolean', 'indicator'));
        await this.extendObject(`${p}.alarm`, ro('Alarm', 'boolean', 'indicator.alarm'));
        await this.extendObject(`${p}.open2`, ro('Zustand offen 2', 'boolean', 'sensor'));
        await this.extendObject(`${p}.raw`, ro('Registerwert', 'number', 'value'));
        if (this.control) {
            await this.extendObject(`${p}.ack`, rw('Alarm quittieren', 'boolean', 'button', { def: false }));
        }
    }

    async createClimate(c) {
        const p = `climate.${c.id}`;
        await this.extendObject('climate', { type: 'folder', common: { name: 'Temperatur / Feuchte' }, native: {} });
        await this.extendObject(p, { type: 'channel', common: { name: c.name || `NOX ${c.kind.toUpperCase()} ${c.id}` }, native: { id: c.id } });
        const defs = {
            fault: ro('Fühlerfehler', 'boolean', 'indicator.maintenance'),
            tempAlarm: ro('Temperaturalarm', 'boolean', 'indicator.alarm'),
            humAlarm: ro('Feuchtealarm', 'boolean', 'indicator.alarm'),
            open: ro('Gehäuse offen', 'boolean', 'indicator.alarm'),
            missing: ro('Gerät fehlt', 'boolean', 'indicator.maintenance'),
            temperature: ro('Temperatur', 'number', 'value.temperature', { unit: '°C' }),
            humidity: ro('Luftfeuchte', 'number', 'value.humidity', { unit: '%' }),
        };
        for (const [, key] of N.CLIMATE[c.kind]) {
            await this.extendObject(`${p}.${key}`, defs[key]);
        }
    }

    async poll() {
        clearTimeout(this.timer);
        if (this.stopped) {
            return;
        }
        let wait = this.interval;
        try {
            await this.mb.connect();
            if (!this.scanned) {
                await this.scan();
            }
            await this.readAll();
            if (this.failures || !this.connectedOnce) {
                await this.setState('info.connection', true, true);
            }
            this.connectedOnce = true;
            this.failures = 0;
            this.lastError = '';
        } catch (err) {
            this.failures++;
            if (err.message !== this.lastError) {
                this.log.warn(`NOX: ${err.message}`);
                this.lastError = err.message;
            }
            if (this.failures === 1) {
                await this.setState('info.connection', false, true);
            }
            wait = Math.min(30000, this.interval * 2 ** Math.min(this.failures, 5));
        }
        if (!this.stopped) {
            this.timer = setTimeout(() => this.poll(), wait);
        }
    }

    async readAll() {
        const climateRegs = this.climate.flatMap(c => N.CLIMATE[c.kind].map(([o]) => c.id * 10 + o));
        const raw = await this.readRegs([...this.areas, ...this.inputs, ...climateRegs]);
        const val = r => (raw.has(r) ? this.fix(raw.get(r)) : undefined);
        if (!this.version) {
            this.version = N.detectVersion(this.areas.map(val).filter(v => v !== undefined));
            if (this.version) {
                this.log.info(`Bereichszustände: Version ${this.version}`);
                await this.put('info.areaVersion', this.version);
            }
        } else if (!this.last.has('info.areaVersion')) {
            await this.put('info.areaVersion', this.version);
        }
        for (const a of this.areas) {
            const v = val(a);
            if (v === undefined) {
                continue;
            }
            const s = N.parseArea(v, this.version || 2);
            const p = `areas.${a}`;
            await this.put(`${p}.raw`, v);
            await this.put(`${p}.state`, s.code);
            await this.put(`${p}.text`, s.text);
            await this.put(`${p}.armed`, s.armed);
            await this.put(`${p}.alarm`, s.alarm);
            if (s.errors.length) {
                // the NOX reports a failed setting only once
                const text = s.errors.join(', ');
                this.areaErrors.set(a, text);
                this.log.warn(`${this.names.get(`area:${a}`) || `Bereich ${a}`}: Schalten fehlgeschlagen – ${text}`);
            }
            await this.put(`${p}.error`, this.areaErrors.get(a) || '');
        }
        for (const r of this.inputs) {
            const v = val(r);
            if (v === undefined) {
                continue;
            }
            const s = N.parseInput(v);
            const p = `inputs.${r}`;
            await this.put(`${p}.raw`, v);
            for (const key of ['open', 'sabotage', 'deactivated', 'alarm', 'open2']) {
                await this.put(`${p}.${key}`, s[key]);
            }
        }
        for (const c of this.climate) {
            for (const [o, key] of N.CLIMATE[c.kind]) {
                const v = val(c.id * 10 + o);
                if (v === undefined) {
                    continue;
                }
                const out = key === 'temperature' ? N.temperature(v) : key === 'humidity' ? v : v !== 0;
                await this.put(`climate.${c.id}.${key}`, out);
            }
        }
    }

    /** writes a state only when it changed (or was never written) */
    async put(id, val) {
        if (this.last.get(id) === val) {
            return;
        }
        this.last.set(id, val);
        await this.setState(id, val, true);
    }

    async onStateChange(id, state) {
        if (!state || state.ack || !id.startsWith(`${this.namespace}.`)) {
            return;
        }
        const rel = id.slice(this.namespace.length + 1);
        const from = String(state.from || '').replace(/^system\.adapter\./, '');
        this.log.info(`Befehl ${rel} = ${state.val}${from ? ` (von ${from})` : ''}`);
        const restore = async () => {
            // show the real value again
            const key = rel;
            const old = this.last.get(key);
            this.last.delete(key);
            if (old !== undefined) {
                await this.put(key, old);
            }
        };
        if (!this.control) {
            this.log.warn('Steuern ist in den Einstellungen nicht erlaubt');
            return restore();
        }
        try {
            let m;
            if ((m = /^areas\.(\d+)\.(armed|setState)$/.exec(rel))) {
                const want = m[2] === 'armed' ? (state.val === true || state.val === 'true' || state.val === 1 ? 5 : 1) : Number(state.val);
                if (!Number.isInteger(want) || want < 1 || want > 5) {
                    throw new Error('Zustand nur 1-5 möglich');
                }
                this.areaErrors.delete(Number(m[1]));
                await this.mb.writeMultiple(Number(m[1]) + this.offset, [this.fix(want)]);
                if (m[2] === 'setState') {
                    await this.setState(rel, want, true);
                }
            } else if ((m = /^inputs\.(\d+)\.(deactivated|ack)$/.exec(rel))) {
                const reg = Number(m[1]) + this.offset;
                if (m[2] === 'deactivated') {
                    const on = state.val === true || state.val === 'true' || state.val === 1;
                    await this.mask(reg, 7, on);
                } else if (state.val) {
                    await this.mask(reg, 6, true);
                    await this.setState(rel, false, true);
                }
            } else if (rel === 'control.ackAll') {
                if (state.val) {
                    await this.mb.writeMultiple(N.ACK_ALL + this.offset, [this.fix(1)]);
                    await this.setState(rel, false, true);
                }
            } else {
                return;
            }
        } catch (err) {
            this.log.warn(`Befehl ${rel} fehlgeschlagen: ${err.message}`);
            await restore();
        }
        // the result shows in the next read (written again then, with ack)
        this.last.delete(rel);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.poll(), 300);
    }

    /** set or clear one bit with "mask write register" (in the NOX's byte order) */
    async mask(reg, bit, on) {
        const b = 1 << bit;
        // Modbus: result = (current AND and) OR (or AND NOT and) - the bit is cleared in "and", set again by "or"
        await this.mb.maskWrite(reg, this.fix(0xffff & ~b), this.fix(on ? b : 0));
    }

    onUnload(callback) {
        this.stopped = true;
        clearTimeout(this.timer);
        try {
            if (this.mb) {
                this.mb.close();
            }
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Nox(options);
} else {
    new Nox();
}
