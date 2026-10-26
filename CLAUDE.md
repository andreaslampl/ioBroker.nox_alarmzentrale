# ioBroker.nox_Alarmzentrale

ioBroker adapter for NOX intrusion alarm systems via the NOX Modbus server (TCP, port 502). Built only from the
NOX wiki page "Modbus Server" the owner sent (PDF, partner wiki - not in the repo). The owner had integrated it with
the generic modbus adapter + Blockly and wanted readable states instead.

## Layout

- `lib/modbus.js` – `ModbusClient` (copy of ioBroker.versicharge's, without FC 06): one connection, serialized
  requests, FC 03 read, FC 16 write multiple, FC 22 mask write (the NOX supports only 03/10/16 hex).
- `lib/nox.js` – register meaning: areas 1-999 (bits 0-9 state: version 1 = one bit, version 2 = number; 10-13 failed
  setting reasons, cleared by the NOX after one read; 14 alarm; 15 used), inputs (R9: 10000 + n - 1; older: module
  ID * 10 + input; bits 0 open, 1 sabotage, 2 deactivated, 3 alarm, 4 open2, 15 used; write bit 7 = deactivate,
  bit 6 = acknowledge via mask write), register 1000 = 1 acks all, THS/THT ID*10+1..8 (temp > 2000 = negative).
  `detectOrder()` (used bit 15 vs. bit 7 = swapped bytes), `detectVersion()`, `parseRanges()`, `blocks()`.
- `main.js` – scan configured ranges on (re)connect, create only used areas/inputs, poll every `interval` s (1 s),
  states on change; area failure bits kept in `areas.N.error` until the next command; commands only with
  `allowControl` (default off - keep it that way), logged with sender; writes in the detected byte order;
  mask write: and = ~bit, or = bit or 0.
- `test/` – `node --test`; `fake.js` = fake NOX (functions 03/10/16, swapped bytes, offset, version 1/2, refused
  arming) + fake adapter-core.

## Name

- Repo `ioBroker.nox_Alarmzentrale` (owner's choice), adapter ID `nox_alarmzentrale` - `iobroker url` derives the
  adapter name from the repo name, so they must match (see the fc20-cerberus-bacnet field log).

## Status

- 0.1.0: owner's values from the modbus adapter: 128 = closed, 384 = open -> bytes swapped (0x8000 used, 0x8001
  used + open); `byteOrder` auto handles it. Not yet tested against the real NOX: unit ID, address offset (register
  1 = address 1 assumed), whether the NOX itself sends swapped bytes or the owner's modbus adapter was just set to
  little endian (either way the detection looks at the bytes on the wire, writes use the same order), whether unused registers read 0
  or raise an exception (both handled), whether two Modbus clients are allowed.

- 0.1.1: owner sent their modbus adapter list (areas 1-2, inputs 10020-10096, type uint16le, names) and asked to
  build the names in - not committed (personal data); instead `modbusImport` ('modbus.N'): `importModbus()` reads
  `system.adapter.modbus.N` native.holdingRegs/inputRegs (`_address`, `name`), adds the registers to the scan and
  uses the names (own table wins). Owner's values: areas 384 (= 0x8001 version 2 Unscharf), 1408 = open + deactivated;
  their modbus adapter was set to little endian, so the NOX itself sends standard order.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.nox_Alarmzentrale`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses or detector names in the repository (use 192.168.1.x examples).
