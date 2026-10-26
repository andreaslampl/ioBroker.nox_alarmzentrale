'use strict';

/* Fake NOX Modbus server (functions 03, 16, 22 like the NOX wiki) and a fake adapter-core. */

const net = require('node:net');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const swap = v => ((v & 0xff) << 8) | (v >> 8);

/**
 * @param {object} o version (area states 1 = bits, 2 = number), swapped (bytes low first, like the owner's reading),
 *   offset (register n is at address n + offset), refuseArm (area -> error bit when it should be armed)
 */
function fakeNox({ unitId = 1, version = 2, swapped = false, offset = 0, refuseArm = {}, maskStyle = 'std' } = {}) {
    const regs = new Map();
    const code = n => (version === 2 ? n : 1 << n);
    const n = {
        regs,
        writes: [],
        reads: [],
        open: new Set(),
        silent: false,
        version,
        area(a, state, extra = 0) {
            regs.set(a, 0x8000 | code(state) | extra);
        },
        input(r, bits = 0) {
            regs.set(r, 0x8000 | bits);
        },
        get(r) {
            return regs.get(r) || 0;
        },
    };
    const word = v => (swapped ? swap(v) : v);
    n.server = net.createServer(sock => {
        if (n.open.size >= 1) {
            sock.destroy();
            return;
        }
        n.open.add(sock);
        sock.on('close', () => n.open.delete(sock));
        sock.on('error', () => {});
        let buf = Buffer.alloc(0);
        sock.on('data', d => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 7 && buf.length >= 6 + buf.readUInt16BE(4)) {
                const frame = buf.subarray(0, 6 + buf.readUInt16BE(4));
                buf = buf.subarray(frame.length);
                if (n.silent || frame[6] !== unitId) {
                    continue;
                }
                const pdu = frame.subarray(7);
                const answer = body => {
                    const head = Buffer.alloc(7);
                    frame.copy(head, 0, 0, 4);
                    head.writeUInt16BE(body.length + 1, 4);
                    head.writeUInt8(frame[6], 6);
                    sock.write(Buffer.concat([head, body]));
                };
                const exc = c => answer(Buffer.from([pdu[0] | 0x80, c]));
                const fc = pdu[0];
                const addr = pdu.readUInt16BE(1) - offset;
                if (fc === 3) {
                    const count = pdu.readUInt16BE(3);
                    n.reads.push([addr, count]);
                    const out = Buffer.alloc(2 + count * 2);
                    out[0] = 3;
                    out[1] = count * 2;
                    for (let i = 0; i < count; i++) {
                        const r = addr + i;
                        out.writeUInt16BE(word(n.get(r)), 2 + i * 2);
                        // a failed setting is reported once
                        if (r >= 1 && r <= 999 && n.get(r) & 0x3c00) {
                            regs.set(r, n.get(r) & ~0x3c00);
                        }
                    }
                    answer(out);
                } else if (fc === 0x10) {
                    const v = word(pdu.readUInt16BE(6));
                    n.writes.push(['set', addr, v]);
                    if (addr === 1000) {
                        if (v === 1) {
                            for (const [r, x] of regs) {
                                if (r >= 10000) {
                                    regs.set(r, x & ~8);
                                }
                            }
                        }
                    } else if (addr >= 1 && addr <= 999 && regs.has(addr)) {
                        if (v === 5 && refuseArm[addr] !== undefined) {
                            regs.set(addr, n.get(addr) | (1 << refuseArm[addr]));
                        } else {
                            regs.set(addr, (n.get(addr) & ~0x3ff) | code(v));
                        }
                    } else {
                        exc(2);
                        continue;
                    }
                    answer(pdu.subarray(0, 5));
                } else if (fc === 0x16) {
                    const and = word(pdu.readUInt16BE(3));
                    const or = word(pdu.readUInt16BE(5));
                    n.writes.push(['mask', addr, and, or]);
                    const cur = n.get(addr);
                    // std = Modbus spec; inv = "and" names the bits to change (ignores the spec variant)
                    const next = maskStyle === 'inv' ? (cur & ~and) | (or & and) : (cur & and) | (or & ~and);
                    // bit 7 = deactivate (shows as bit 2), bit 6 = acknowledge (clears the alarm bit 3)
                    let st = next & 0x80 ? cur | 4 : cur & ~4;
                    if (next & 0x40) {
                        st &= ~8;
                    }
                    regs.set(addr, st);
                    answer(pdu.subarray(0, 7));
                } else {
                    exc(1);
                }
            }
        });
    });
    n.listen = () => new Promise(r => n.server.listen(0, '127.0.0.1', () => r(n.server.address().port)));
    n.close = () =>
        new Promise(r => {
            for (const s of n.open) {
                s.destroy();
            }
            n.server.close(() => r());
        });
    return n;
}

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.connected = true;
        this.config = options.config;
        this.states = {};
        this.objects = {};
        this.logs = [];
        const log = level => m => this.logs.push(`${level}: ${m}`);
        this.log = { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
    }
    _id(id) {
        return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
    }
    async setState(id, val, ack) {
        this.states[this._id(id)] = { val, ack: Boolean(ack) };
    }
    async getStateAsync(id) {
        return this.states[this._id(id)] || null;
    }
    async getForeignObjectAsync(id) {
        return (this.foreignObjects && this.foreignObjects[id]) || null;
    }
    async extendObject(id, obj) {
        this.objects[this._id(id)] = obj;
    }
    subscribeStates() {}
    val(id) {
        const s = this.states[this._id(id)];
        return s ? s.val : undefined;
    }
    /** a user or another adapter writes a command */
    command(id, val) {
        const full = this._id(id);
        this.states[full] = { val, ack: false, from: 'system.adapter.admin.0' };
        this.emit('stateChange', full, this.states[full]);
    }
}

function install() {
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter };
        }
        return orig.call(this, request, ...rest);
    };
}

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

module.exports = { fakeNox, FakeAdapter, install, until, swap };
