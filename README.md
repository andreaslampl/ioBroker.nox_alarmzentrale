# ioBroker.nox_Alarmzentrale

NOX-Alarmanlage in ioBroker über den **Modbus-Server der NOX** (lokal, ohne Cloud). Bereiche, Melder und
NOX THS/THT werden als lesbare Datenpunkte angelegt – kein Umrechnen der Registerwerte in Blockly mehr.

Gebaut nach der NOX-Wiki-Seite „Modbus Server“ (NOX System ab V8.60).

## Installation

```
iobroker url https://github.com/andreaslampl/ioBroker.nox_Alarmzentrale
```

Danach eine Instanz anlegen. Läuft schon der **modbus-Adapter** für die NOX, diese Instanz anhalten –
ob die NOX zwei Modbus-Verbindungen gleichzeitig annimmt, ist nicht dokumentiert.

## Einstellungen

| Feld | Bedeutung |
| --- | --- |
| Adresse, Port, Unit-ID | NOX-Zentrale (Port meist 502) |
| Abfrage alle | Standard 1 s |
| Register der Bereiche | Bereich 1 = Register 1, z. B. `1-16` |
| Register der Melder | Ab R9: NOX-Eingang 1 = Register 10000 (die NOX kann eine Export-Liste mit allen Registern erzeugen). Älter: Modul-ID + Eingang, z. B. `20011-20018`. Mehrere Bereiche mit Komma. |
| NOX-Exportliste (CSV) | Export der NOX (.csv) im Editor öffnen, alles kopieren und einfügen: Namen, Bereich und Register aller Melder. Register = 10000 + laufende Nummer des Eingangs in der Liste. |
| Aus modbus-Instanz übernehmen | z. B. `modbus.0`: Namen und Register aus dem modbus-Adapter, der die NOX bisher liest – nichts abtippen. Diese Namen gehen vor die aus der Exportliste, eigene Namen in der Tabelle unten haben Vorrang. |
| Byte-Reihenfolge | **automatisch** erkennt sie selbst. Hintergrund: Werte wie 128 (Ruhe) und 384 (offen) sind nur vertauschte Bytes – eigentlich 32768 = „Melder wird benutzt“ und 32769 = „benutzt + offen“. |
| Bereichszustände | Version 1 (ein Bit pro Zustand) oder 2 (Zahl, NOX ab 9.71) – automatisch erkannt |
| Adressversatz | falls die Werte um ein Register verrutscht sind |
| Steuern erlauben | aus = nur lesen (Standard) |
| Namen | Namen für Bereiche/Melder (Register-Nummer) |
| NOX THS / THT | ID-Nummer des Geräts → Temperatur und Feuchte |

Der Adapter liest beim Start alle Register der angegebenen Bereiche und legt nur die an, die die NOX als
**„benutzt“** meldet (Bit 15). Die Anzahl steht in `info.areas` / `info.inputs`.

## Datenpunkte

**Bereiche** `nox_alarmzentrale.0.areas.<Nr>`

| Datenpunkt | |
| --- | --- |
| `state` / `text` | 0 Unbekannt, 1 Unscharf, 2 Ausgangsverzögerung, 3 Ausgang wartet, 4 Eingangsverzögerung, 5 Scharf, 6 Teilscharf |
| `armed` | scharf (true) / unscharf (false) – mit „Steuern erlauben“ auch schaltbar |
| `alarm` | es gibt aktive Alarme im Bereich |
| `error` | warum das letzte Scharfschalten scheiterte (Sperrzeit, keine Berechtigung, aktive Melder, aktive Alarme) |
| `setState` | (nur mit Steuern) Zustand 1–5 setzen |
| `raw` | Registerwert (zur Kontrolle) |

**Melder** `nox_alarmzentrale.0.inputs.<Register>`: `open` (offen/Bewegung), `sabotage`, `deactivated` (abgeschaltet –
mit Steuern auch schaltbar), `alarm`, `open2`, `raw`, `ack` (nur mit Steuern: Alarm quittieren).

**Alle Alarme quittieren**: `nox_alarmzentrale.0.control.ackAll` (nur mit Steuern).

**NOX THS/THT** `nox_alarmzentrale.0.climate.<ID>`: `temperature`, `humidity`, Alarme, Fühlerfehler, Gerät fehlt.

## Sicherheit

Scharf/unscharf, Melder abschalten und Quittieren gehen nur mit dem Haken **„Steuern erlauben“**. Ohne Haken
werden Befehle abgelehnt (Warnung im Log) und der echte Zustand wieder angezeigt. Jeder Befehl wird mit Absender
ins Log geschrieben („Befehl areas.1.armed = true (von …)“).

## Lizenz

MIT
