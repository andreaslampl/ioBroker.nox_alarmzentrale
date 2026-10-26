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
- Field: `iobroker url …/ioBroker.nox_Alarmzentrale` failed with "Cannot install …: 0" (exit 25): js-controller takes the
  adapter name from the URL with its case (`nox_Alarmzentrale`) and looks for node_modules/iobroker.nox_Alarmzentrale,
  npm installs lowercase. Install with the lowercase URL (GitHub ignores case) - or rename the repo to lowercase.

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

- 0.1.2: owner sent the NOX export list (CSV `UnitType;InputOutput;ID;Name;Area;InputProfile`, unit rows then I/O rows,
  names `{02Name¦Zusatz}`, 02 = German) - not committed. Every I row in list order = next input, register = 10000 +
  running number: matched 12/12 of the owner's modbus addresses (so with offset 0 the NOX's "input 1 = 10000" is
  the list's first input at 10001 - whatever the reason, the field data wins). Pasted into `exportCsv`
  (`parseExport()`); name priority: own table > modbus import > export; `inputs.N.area` from the list.

- 0.1.2 field: installed with the lowercase URL; owner: "Funktioniert sehr gut" (reading confirmed on the real NOX).
  Control (arm/disarm, deactivate, acknowledge) not yet tested.

- 0.1.3: owner: "Melder Abschalten geht nicht" (no log yet). `checkDeactivate()` reads the register before the mask
  write and 1.5 s after, logs both (info if the bit changed, warn if not). Open questions: allowControl ticked?
  Modbus exception? The wiki's deactivation example uses an ID-based register (22103) - maybe mask write does not
  work on the R9 registers (10000+), or the NOX's Modbus user lacks the right.

- 0.1.3 field log: scan found 6 areas, 97 inputs, byte order standard, area version 2. Deactivating an input (R9
  register, area disarmed): mask write accepted without exception, value stays 0x8000 -> the NOX ignores it. Not built:
  writing to the ID-based register (module ID * 10 + input) - for bus 1 those numbers (10011-19999) overlap the R9
  registers of OTHER inputs, a wrong guess could switch off a different detector. Asked the owner to check in the NOX
  whether the input profile allows deactivation / the Modbus server has the right, whether the keypad can switch the
  same detector off, and whether arming (register write) works at all.

- Owner (is the installer himself) sent the NOX programming (.sqlite, contains user codes - looked only at profiles/
  areas/modbus, copy deleted, nothing committed). Findings: table NoxInputs has a `ModbusRegister` column (MK input =
  10022 as used) -> the adapter writes to the right register. Input profile of the MK inputs = 40; user profile
  "Managementsystem" may deactivate all profiles; NoxAreas.AllowDisable = 0 for every area (meaning unclear - another
  input in area 2 is deactivated); Modbus server settings are an unlabeled tab list in NoxConfig.AddSetup
  ("Modbus 503 1 11 1 0 0 0 1 0 1 ..."), not decodable without the tool's labels. Asked for a screenshot of the
  Modbus server page and the area option, and how the other input was deactivated.

- Owner's NOX Modbus server page: port 503, allowed functions all ticked (area switching, decimal area state,
  deactivation "immer (auch wenn scharf)", acknowledging), Address-Offset 0, addressing "Eingangsnummer -> Modbus
  Adresse". So rights were fine -> suspected non-standard mask write. 0.1.4: `deactivate()` tries the spec variant
  (and = ~bit) and, if the bit did not change after 1.5 s, the inverse one (and = bit); the working one is kept in
  `info.maskMode` (state, survives restarts). Deactivation commands run one after another (`deactChain`).

- 0.1.4 field: switching off worked with "inv" (and = bit 7, or = bit 7), switching on with "inv" (and = bit 7, or = 0)
  did not. All field results fit "new = (internal bits incl. bit 7 OR or) AND and" (fake `maskStyle: 'nox'`): off needs
  inv, on needs std. 0.1.5: learned per direction (`info.maskModeOn` / `info.maskModeOff`; old `info.maskMode`
  migrated to On); ack (bit 6) with the "inv" NOX sends bit 7 along in and/or when the input is deactivated, else
  it would switch the detector on.

- 0.1.5 confirmed by the owner on the real NOX: switching detectors off and on works ("Funktioniert Perfekt").
  Arming/disarming and acknowledging not yet reported.

- 0.1.6: owner asked for a "zu = true" state like at the SPC (there: zones.N.open + numeric input) -> `inputs.N.closed`
  = !open.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.nox_alarmzentrale`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses or detector names in the repository (use 192.168.1.x examples).
