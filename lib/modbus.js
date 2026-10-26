'use strict';

/*
 * Minimal Modbus TCP client: one persistent connection, requests strictly one after another,
 * FC 03 (read holding registers), FC 16 (write multiple) and FC 22 (mask write register) - the
 * functions the NOX Modbus server supports. Addresses are the ones sent in the request.
 */

const net = require('node:net');
const { EventEmitter } = require('node:events');

const EXCEPTIONS = {
    1: 'Funktion nicht unterstützt',
    2: 'Adresse nicht erlaubt',
    3: 'Wert nicht erlaubt',
    4: 'Fehler im Gerät',
    6: 'Gerät beschäftigt',
};

class ModbusError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

class ModbusClient extends EventEmitter {
    /**
     * @param {object} o host, port (502), unitId (1), timeout ms (5000), gap ms between requests
     */
    constructor({ host, port = 502, unitId = 1, timeout = 5000, gap = 20 }) {
        super();
        this.host = host;
        this.port = port;
        this.unitId = unitId;
        this.timeout = timeout;
        this.gap = gap;
        this.socket = null;
        this.connecting = null;
        this.tid = 0;
        this.pending = null; // {tid, resolve, reject, timer}
        this.buf = Buffer.alloc(0);
        this.chain = Promise.resolve();
        this.closed = false;
    }

    get connected() {
        return Boolean(this.socket);
    }

    connect() {
        if (this.socket) {
            return Promise.resolve();
        }
        if (!this.connecting) {
            this.connecting = new Promise((resolve, reject) => {
                const s = net.connect({ host: this.host, port: this.port });
                const fail = err => {
                    clearTimeout(timer);
                    s.destroy();
                    this.connecting = null;
                    reject(err);
                };
                const timer = setTimeout(() => fail(new Error(`Keine Verbindung zu ${this.host}:${this.port} (Zeitüberschreitung)`)), this.timeout);
                s.once('error', fail);
                s.once('connect', () => {
                    clearTimeout(timer);
                    s.removeListener('error', fail);
                    s.setNoDelay(true);
                    s.setKeepAlive(true, 10000);
                    s.on('data', d => this._data(d));
                    s.on('error', err => this._drop(err));
                    s.on('close', () => this._drop(new Error('Verbindung getrennt')));
                    this.socket = s;
                    this.buf = Buffer.alloc(0);
                    this.connecting = null;
                    this.emit('connect');
                    resolve();
                });
            });
        }
        return this.connecting;
    }

    _drop(err) {
        if (!this.socket) {
            return;
        }
        this.socket.destroy();
        this.socket = null;
        if (this.pending) {
            this.pending.reject(err);
        }
        this.emit('disconnect', err);
    }

    _data(d) {
        this.buf = Buffer.concat([this.buf, d]);
        while (this.buf.length >= 7) {
            const len = this.buf.readUInt16BE(4);
            if (this.buf.length < 6 + len) {
                return;
            }
            const frame = this.buf.subarray(0, 6 + len);
            this.buf = this.buf.subarray(6 + len);
            const tid = frame.readUInt16BE(0);
            if (this.pending && this.pending.tid === tid) {
                this.pending.resolve(frame.subarray(7)); // PDU: function code + data
            }
        }
    }

    /** queue a request; returns the response PDU */
    _request(pdu) {
        const run = () => this._send(pdu);
        const p = this.chain.then(run, run);
        this.chain = p.catch(() => {}).then(() => new Promise(r => setTimeout(r, this.gap)));
        return p;
    }

    async _send(pdu) {
        if (this.closed) {
            throw new Error('Verbindung beendet');
        }
        await this.connect();
        this.tid = (this.tid + 1) & 0xffff;
        const tid = this.tid;
        const head = Buffer.alloc(7);
        head.writeUInt16BE(tid, 0);
        head.writeUInt16BE(0, 2);
        head.writeUInt16BE(pdu.length + 1, 4);
        head.writeUInt8(this.unitId, 6);
        const res = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending = null;
                reject(new Error('Keine Antwort von der NOX (Zeitüberschreitung)'));
                // a late answer would confuse the next request
                this._drop(new Error('Zeitüberschreitung'));
            }, this.timeout);
            this.pending = {
                tid,
                resolve: v => {
                    clearTimeout(timer);
                    this.pending = null;
                    resolve(v);
                },
                reject: e => {
                    clearTimeout(timer);
                    this.pending = null;
                    reject(e);
                },
            };
            this.socket.write(Buffer.concat([head, pdu]));
        });
        if (res[0] & 0x80) {
            const code = res[1];
            throw new ModbusError(`Modbus-Fehler ${code}: ${EXCEPTIONS[code] || 'unbekannt'}`, code);
        }
        if (res[0] !== pdu[0]) {
            throw new Error(`Falsche Antwort (Funktion ${res[0]} statt ${pdu[0]})`);
        }
        return res;
    }

    /** FC 03: count registers from addr -> array of uint16 */
    async read(addr, count) {
        const pdu = Buffer.alloc(5);
        pdu.writeUInt8(3, 0);
        pdu.writeUInt16BE(addr, 1);
        pdu.writeUInt16BE(count, 3);
        let res;
        try {
            res = await this._request(pdu);
        } catch (err) {
            if (err instanceof ModbusError) {
                // which register (external number) the charger refused
                throw new ModbusError(`${err.message} (Register ${addr}${count > 1 ? `–${addr + count - 1}` : ''})`, err.code);
            }
            throw err;
        }
        if (res[1] !== count * 2 || res.length < 2 + count * 2) {
            throw new Error(`Falsche Länge der Antwort (${res[1]} Bytes für ${count} Register)`);
        }
        const out = [];
        for (let i = 0; i < count; i++) {
            out.push(res.readUInt16BE(2 + i * 2));
        }
        return out;
    }


    /** FC 16 */
    async writeMultiple(addr, values) {
        const pdu = Buffer.alloc(6 + values.length * 2);
        pdu.writeUInt8(16, 0);
        pdu.writeUInt16BE(addr, 1);
        pdu.writeUInt16BE(values.length, 3);
        pdu.writeUInt8(values.length * 2, 5);
        values.forEach((v, i) => pdu.writeUInt16BE(v & 0xffff, 6 + i * 2));
        await this._request(pdu);
    }

    /** FC 22: register = (register AND and) OR (or AND NOT and) */
    async maskWrite(addr, and, or) {
        const pdu = Buffer.alloc(7);
        pdu.writeUInt8(0x16, 0);
        pdu.writeUInt16BE(addr, 1);
        pdu.writeUInt16BE(and & 0xffff, 3);
        pdu.writeUInt16BE(or & 0xffff, 5);
        await this._request(pdu);
    }

    close() {
        this.closed = true;
        if (this.socket) {
            this.socket.removeAllListeners('close');
            this.socket.destroy();
            this.socket = null;
        }
    }
}

module.exports = { ModbusClient, ModbusError };
