# Hardware

SidClock runs on the **Saphe T** device: a Nordic **nRF54L15** (Cortex-M33)
board with a 368x448 AMOLED/LCD panel, touch, motion and ambient light
sensing, a class-D speaker amplifier and a 4 MiB external SPI flash.

## Parts

| Function | Part | Interface | Notes |
|---|---|---|---|
| MCU | Nordic nRF54L15 | - | 1.5 MB RRAM, 256 KB RAM, Bluetooth LE |
| Display | SH8601-class AMOLED or GC9307 LCD | SPI (SPIM00 CS1) | 368x448, RGB565, QSPI-style framing (no D/C pin) |
| Touch | FocalTech FT3168 | I2C (TWIM30, 0x38) | interrupt + reset lines |
| Accelerometer | ST LIS2DH | I2C (TWIM30, 0x19) | used for idle-face orientation |
| Ambient light | TI OPT3007 or OPT4001 | I2C (TWIM30, 0x45) | both supported, auto-detected |
| Audio amp | Awinic AW88082 (or MAX98357A on early units) | I2S (I2S20) | class-D, no codec configuration |
| External flash | Macronix MX25R64-class | SPI (SPIM00 CS0) | 4 MiB: OTA slot + LittleFS `/home` |
| Battery | via SAADC AIN7 | - | charge status on P1.12/P1.13 |

There are no GPIO buttons, LEDs or haptics. One physical button sits flush
with the case on the side; it is wired to the nRF54L15's reset pin and
simply reboots the device (it is not a software input).

## Debug access (SWD)

On the back of the PCB, next to the two visible charging contacts, the
board has **four pads at the same pitch: SWDIO, 5V, GND, SWDCLK**. The
charging contacts are exposed; the two SWD pads are hidden under the black
back-cover sticker/foil glued directly onto the PCB and must be carefully
scratched free.

The port runs at **1.8 V logic** - use a probe with level shifters and a
VTref connection; 3.3 V logic may damage the SWD port. See
[backup-unlock-flash.md](backup-unlock-flash.md) for the unlock procedure.

## Hardware revisions

Three board revisions exist; the differences are the audio amplifier, the
panel vendor and the light sensor:

| Rev | Amplifier | Panel | Light sensor |
|---|---|---|---|
| 0 | MAX98357A | SH8601 (ORIC) | OPT3007 |
| 1 | AW88082 | SH8601 (ORIC) | OPT4001 |
| 2 | AW88082 | SH8601 (NISIN) | OPT4001 |
| unknown/default | AW88082 | SH8601 (ORIC) | auto-detect |

SidClock is configured for the common **AW88082** wiring and auto-detects
the light sensor at probe. The panel init sequence works for the SH8601
variants; `audio.c` can switch the I2S pin roles at runtime for the
MAX98357A wiring if you port the variant selection.

## Pin map

| Signal | Pin | Notes |
|---|---|---|
| I2C30 SCL / SDA | P0.00 / P0.01 | touch, accel, ALS |
| Panel power enable | P0.02 | driven high during display init |
| Panel reset | P0.04 | active low |
| I2S SDOUT | P1.06 | audio data (see UART note below) |
| I2S SCK | P1.05 | bit clock |
| I2S LRCK | P1.07 (AW88082) / P1.04 (MAX98357A) | word select |
| Amp enable | P1.04 (AW88082) / P1.07 (MAX98357A) | driven high while the stream runs |
| Flash CS | P1.08 | SPIM00 CS0 |
| Touch INT / RST | P1.09 / P1.10 | |
| Sensor rail / I2C enable | P1.11 | **must be high** or touch/accel/ALS are unpowered |
| Charge status | P1.12 / P1.13 | |
| Flash RESET# / WP# | P2.00 / P2.03 | |
| SPIM00 SCK / MOSI / MISO | P2.01 / P2.02 / P2.04 | flash + display share the bus |
| Display CS | P2.05 | SPIM00 CS1 |

### The UART that silences the amplifier

The `nrf54l15dk` board maps its console UART to **P1.04/P1.05/P1.06/P1.07**
- exactly the amplifier pins. If the UART is left enabled (bootloader or
application), its TX holds P1.04 high and its RTS holds P1.06 (I2S SDOUT)
low: the I2S clocks perfectly and every register looks right, but no data
reaches the amplifier. SidClock disables the console UART in both the
bootloader (`CONFIG_SERIAL=n`) and the application, and additionally
releases the UARTE20 pins at audio init. There is no UART wired on the
board; logging is done over SEGGER RTT and BLE.

## External flash layout

The MX25R64 is shared between the OTA secondary slot and the LittleFS
filesystem used for tunes and settings:

| Offset | Size | Use |
|---|---|---|
| 0x000000 | 0x151000 | `image-1` - MCUboot secondary slot (OTA) |
| 0x151000 | 0x2AF000 | `storage` - LittleFS mounted at `/home` |

The internal RRAM holds the bootloader (0x0 - 0xE000) and slot 0
(0xE000 - 0x15F000, application linked at 0xE800 after the 0x800 MCUboot
header).

## Power

- Battery voltage is measured on SAADC AIN7 (10-bit, gain 2/3, internal
  reference) and converted with a fixed scaling factor.
- Charging status is read from P1.12/P1.13.
- The amplifier auto-shuts down when the bit clock stops, so the audio
  stream is suspended after ~30 s of silence (see `docs/low-power.md`).
- There is no PMIC and no system power-management driver on this Zephyr
  port; the firmware manages power itself (sensor duty cycling, panel
  sleep, stream suspend, dark sleep mode).
