'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeNox, install, until } = require('./fake');
const N = require('../lib/nox');

install();

test('decoding from the NOX wiki tables', () => {
    assert.deepEqual(N.parseRanges('1-3, 10000-10001;20012'), [1, 2, 3, 20012, 10000, 10001].sort((a, b) => a - b));
    assert.throws(() => N.parseRanges('1-x'), /nicht verständlich/);
    assert.deepEqual(N.blocks([1, 2, 3, 10, 30, 10000, 10001]), [{ addr: 1, count: 10 }, { addr: 30, count: 1 }, { addr: 10000, count: 2 }]);
    // the owner's values from the modbus adapter: 128 = in rest, 384 = open (bytes swapped)
    assert.equal(N.detectOrder([128, 384, 0, 128]), 'le');
    assert.deepEqual(N.parseInput(N.swap(384)), { used: true, open: true, sabotage: false, deactivated: false, alarm: false, open2: false });
    assert.equal(N.detectOrder([0x8000, 0x8001]), 'be');
    // the owner's real values (modbus adapter set to little endian): areas 384 = unarmed, 1408 = open + deactivated
    assert.equal(N.parseArea(N.swap(384), N.detectVersion([N.swap(384), N.swap(384)])).text, 'Unscharf');
    assert.deepEqual(N.parseInput(N.swap(1408)), { used: true, open: true, sabotage: false, deactivated: true, alarm: false, open2: false });
    // area version 2: number, version 1: one bit
    assert.equal(N.parseArea(0x8005, 2).text, 'Scharf');
    assert.equal(N.parseArea(0x8000 | 32, 1).text, 'Scharf');
    assert.equal(N.parseArea(0x8002, 1).text, 'Unscharf');
    assert.deepEqual(N.parseArea(0x8001 | (1 << 12) | 0x4000, 2), { used: true, code: 1, text: 'Unscharf', armed: false, alarm: true, errors: ['aktive Melder im Bereich'] });
    assert.equal(N.detectVersion([0x8001, 0x8005]), 2);
    assert.equal(N.detectVersion([0x8002, 0x8020]), 1);
    assert.equal(N.detectVersion([0x8000]), null);
    // NOX THS/THT temperature
    assert.equal(N.temperature(382), 38.2);
    assert.equal(N.temperature(2123), -12.3);
});

async function start(t, config = {}, noxOpts = {}, setup = () => {}, foreign = {}) {
    const nox = fakeNox(noxOpts);
    setup(nox);
    const port = await nox.listen();
    const adapter = require('../main.js')({ config: { host: '127.0.0.1', port, unitId: 1, pollMs: 60, areas: '1-4', inputs: '10000-10009', ...config } });
    adapter.foreignObjects = foreign;
    adapter.emit('ready');
    t.after(async () => {
        await new Promise(r => adapter.emit('unload', r));
        await nox.close();
    });
    await until(() => adapter.val('info.connection') === true);
    return { nox, adapter };
}

const house = nox => {
    nox.area(1, 1);
    nox.area(2, 5);
    nox.input(10000);
    nox.input(10001, 1);
    nox.input(10003, 8);
};

test('swapped bytes (as the owner reads them): areas and detectors found, states, version detected', async t => {
    const { adapter } = await start(t, { names: [{ kind: 'input', nr: 10001, name: 'Haustür' }, { kind: 'area', nr: 2, name: 'Garage' }] }, { swapped: true }, house);
    await until(() => adapter.val('areas.2.text') === 'Scharf');
    assert.equal(adapter.val('info.byteOrder'), 'vertauscht');
    assert.equal(adapter.val('info.areaVersion'), 2);
    assert.deepEqual([adapter.val('info.areas'), adapter.val('info.inputs')], [2, 3]);
    assert.equal(adapter.objects['nox_alarmzentrale.0.inputs.10001'].common.name, 'Haustür');
    assert.equal(adapter.objects['nox_alarmzentrale.0.areas.2'].common.name, 'Garage');
    assert.equal(adapter.objects['nox_alarmzentrale.0.areas.3'], undefined, 'unused area');
    assert.equal(adapter.val('areas.1.armed'), false);
    assert.equal(adapter.val('areas.2.armed'), true);
    assert.equal(adapter.val('inputs.10001.open'), true);
    assert.equal(adapter.val('inputs.10000.open'), false);
    assert.equal(adapter.val('inputs.10003.alarm'), true);
    assert.equal(adapter.objects['nox_alarmzentrale.0.areas.1.armed'].common.write, false, 'control is off by default');
});

test('control off: commands are refused and the real value stays', async t => {
    const { nox, adapter } = await start(t, {}, {}, house);
    await until(() => adapter.val('areas.1.armed') === false);
    adapter.command('areas.1.armed', true);
    await until(() => adapter.logs.includes('warn: Steuern ist in den Einstellungen nicht erlaubt'));
    await until(() => adapter.states['nox_alarmzentrale.0.areas.1.armed'].ack === true);
    assert.equal(adapter.val('areas.1.armed'), false);
    assert.equal(nox.writes.length, 0);
});

test('control on (version 1 bits, standard byte order): arm, disarm, failed arm reported, deactivate, acknowledge', async t => {
    const { nox, adapter } = await start(t, { allowControl: true }, { version: 1, refuseArm: { 2: 12 } }, nx => {
        nx.area(1, 1);
        nx.area(2, 1);
        nx.input(10000);
        nx.input(10003, 8);
    });
    await until(() => adapter.val('info.areaVersion') === 1);
    adapter.command('areas.1.armed', true);
    await until(() => adapter.val('areas.1.text') === 'Scharf' && adapter.states['nox_alarmzentrale.0.areas.1.armed'].ack);
    assert.deepEqual(nox.writes.at(-1), ['set', 1, 5]);
    adapter.command('areas.1.setState', 1);
    await until(() => adapter.val('areas.1.armed') === false && adapter.states['nox_alarmzentrale.0.areas.1.armed'].ack);
    // the NOX refuses (active detectors) - reported once by the NOX, kept in error
    adapter.command('areas.2.armed', true);
    await until(() => adapter.val('areas.2.error') === 'aktive Melder im Bereich');
    assert.ok(adapter.logs.some(l => /warn: Bereich 2: Schalten fehlgeschlagen – aktive Melder im Bereich/.test(l)));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(adapter.val('areas.2.error'), 'aktive Melder im Bereich', 'stays after the NOX cleared the bits');
    assert.equal(adapter.val('areas.2.armed'), false);
    // deactivate a detector (mask write bit 7) and activate again
    adapter.command('inputs.10000.deactivated', true);
    await until(() => adapter.val('inputs.10000.deactivated') === true && adapter.states['nox_alarmzentrale.0.inputs.10000.deactivated'].ack);
    assert.deepEqual(nox.writes.at(-1), ['mask', 10000, 0xff7f, 0x80]);
    adapter.command('inputs.10000.deactivated', false);
    await until(() => adapter.val('inputs.10000.deactivated') === false && adapter.states['nox_alarmzentrale.0.inputs.10000.deactivated'].ack);
    assert.deepEqual(nox.writes.at(-1), ['mask', 10000, 0xff7f, 0]);
    // acknowledge one alarm (bit 6), all alarms (register 1000)
    adapter.command('inputs.10003.ack', true);
    await until(() => adapter.val('inputs.10003.alarm') === false);
    assert.equal(adapter.val('inputs.10003.ack'), false);
    nox.input(10003, 8);
    await until(() => adapter.val('inputs.10003.alarm') === true);
    adapter.command('control.ackAll', true);
    await until(() => adapter.val('inputs.10003.alarm') === false);
    assert.deepEqual(nox.writes.at(-1), ['set', 1000, 1]);
});

test('swapped bytes: commands are sent swapped too; address offset; climate sensor', async t => {
    const { nox, adapter } = await start(t, { allowControl: true, offset: -1, climate: [{ id: 1200, kind: 'ths', name: 'Serverraum' }] }, { swapped: true, offset: -1 }, nx => {
        house(nx);
        nx.regs.set(12007, 2123);
        nx.regs.set(12008, 67);
        nx.regs.set(12002, 1);
    });
    await until(() => adapter.val('climate.1200.temperature') === -12.3);
    assert.equal(adapter.val('climate.1200.humidity'), 67);
    assert.equal(adapter.val('climate.1200.tempAlarm'), true);
    assert.equal(adapter.val('climate.1200.fault'), false);
    adapter.command('areas.1.armed', true);
    await until(() => adapter.val('areas.1.armed') === true && adapter.states['nox_alarmzentrale.0.areas.1.armed'].ack);
    assert.deepEqual(nox.writes.at(-1), ['set', 1, 5]);
    adapter.command('inputs.10000.deactivated', true);
    await until(() => adapter.val('inputs.10000.deactivated') === true && adapter.states['nox_alarmzentrale.0.inputs.10000.deactivated'].ack);
    assert.deepEqual(nox.writes.at(-1), ['mask', 10000, 0xff7f, 0x80]);
});

test('connection loss: not connected, reconnects and reads the list again', async t => {
    const { nox, adapter } = await start(t, { timeout: 2 }, {}, house);
    adapter.mb.timeout = 200;
    nox.silent = true;
    await until(() => adapter.val('info.connection') === false);
    nox.silent = false;
    nox.input(10005);
    await until(() => adapter.val('info.connection') === true, 8000);
    await until(() => adapter.val('info.inputs') === 4);
    assert.ok(adapter.logs.some(l => /warn: NOX: Keine Antwort/.test(l)));
});

test('names and registers taken over from the modbus adapter (as the owner set it up)', async t => {
    const modbus = { native: { holdingRegs: [
        { _address: 1, name: 'Haus', type: 'uint16le' },
        { _address: 10020, name: 'Haustür', type: 'uint16le' },
        { _address: 10061, name: 'Fenster', type: 'uint16le' },
    ] } };
    const { adapter } = await start(t, { modbusImport: 'modbus.0', names: [{ kind: 'input', nr: 10061, name: 'Eigener Name' }] }, {}, nx => {
        nx.area(1, 1);
        nx.input(10020, 1);
        nx.input(10061, 1 | 4); // 1408 with swapped bytes: open + deactivated
    }, { 'system.adapter.modbus.0': modbus });
    await until(() => adapter.val('inputs.10061.deactivated') === true);
    assert.equal(adapter.objects['nox_alarmzentrale.0.areas.1'].common.name, 'Haus');
    assert.equal(adapter.objects['nox_alarmzentrale.0.inputs.10020'].common.name, 'Haustür', 'outside the configured range, taken from modbus');
    assert.equal(adapter.objects['nox_alarmzentrale.0.inputs.10061'].common.name, 'Eigener Name', 'own table wins');
    assert.equal(adapter.val('inputs.10020.open'), true);
    assert.equal(adapter.val('areas.1.text'), 'Unscharf');
    assert.ok(adapter.logs.includes('info: Übernommen aus modbus.0: 1 Bereich(e), 2 Melder mit Namen'));
});
