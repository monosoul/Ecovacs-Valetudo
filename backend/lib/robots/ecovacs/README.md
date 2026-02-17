# Ecovacs Backend Architecture

This directory contains the Ecovacs robot backend implementation for Valetudo,
targeting the Deebot T8 AIVI.

The implementation uses native JavaScript ROS TCP/XML-RPC clients and
does not rely on Python helper scripts for runtime robot control.

## Design Goals

- Keep ROS connections persistent to avoid connect/setup overhead per command.
- Hide reconnect logic from capability and robot orchestration code.
- Keep protocol code modular and small instead of one monolithic file.
- Make feature additions straightforward.

## Module Layout

- `EcovacsT8AiviValetudoRobot.js`
  - Main robot orchestration, map polling, and map rendering logic.
  - Delegates ROS and `mdsctl` work to service modules.
- `EcovacsQuirkFactory.js`
  - Creates quirk instances for toggle-style settings (auto-collect, room cleaning preferences).
- `RoomLabels.js`
  - Maps numeric label IDs to human-readable room names.
- `capabilities/*`
  - Valetudo capability adapters (see [Capabilities](#capabilities) below).
- `ros/protocol/*`
  - Low-level binary/TCPROS helpers (`BinaryCursor`, `BufferedTcpSocket`, `tcpros`).
- `ros/core/*`
  - Reusable connection and endpoint discovery primitives (`PersistentServiceClient`, `PredictionPoseSubscriber`, `TopicStateSubscriber`, `RosMasterXmlRpcClient`).
- `ros/services/*Service.js`
  - Domain-specific service classes (`EcovacsMapService`, `EcovacsSpotAreaService`, `EcovacsVirtualWallService`, `EcovacsPositionService`, `EcovacsTraceService`, `EcovacsWorkManageService`, `EcovacsSettingService`, `EcovacsLifespanService`, `EcovacsStatisticsService`, `EcovacsRuntimeStateService`).
  - Each service owns its ROS client(s)/subscriber(s), binary serialization, and parsing.
- `ros/services/MdsctlClient.js`
  - Local `mdsctl` command execution wrapper.

## Capabilities

| Capability | Adapter Class | Description |
|---|---|---|
| Basic control | `EcovacsBasicControlCapability` | Start, stop, pause, home |
| Manual control | `EcovacsManualControlCapability` | Remote joystick driving |
| Locate | `EcovacsLocateCapability` | Play sound on robot |
| Auto-empty dock | `EcovacsAutoEmptyDockManualTriggerCapability` | Trigger dust bin emptying |
| Carpet mode | `EcovacsCarpetModeControlCapability` | Suction boost on carpet |
| Clean route | `EcovacsCleanRouteControlCapability` | Cleaning pattern selection |
| Consumables | `EcovacsConsumableMonitoringCapability` | Main brush, side brush, HEPA filter lifespan |
| Fan speed | `EcovacsFanSpeedControlCapability` | Suction power levels |
| Water usage | `EcovacsWaterUsageControlCapability` | Mopping water flow levels |
| Segment edit | `EcovacsMapSegmentEditCapability` | Split/merge rooms |
| Segment rename | `EcovacsMapSegmentRenameCapability` | Change room labels |
| Segment cleaning | `EcovacsMapSegmentationCapability` | Per-room cleaning, per-room preferences (suction/water/times), room cleaning order |
| Zone cleaning | `EcovacsZoneCleaningCapability` | Clean arbitrary rectangular zones |
| Virtual restrictions | `EcovacsCombinedVirtualRestrictionsCapability` | No-go zones, no-mop zones, and line virtual walls |
| Total statistics | `EcovacsTotalStatisticsCapability` | All-time cleaning count, time, area |
| Current statistics | `EcovacsCurrentStatisticsCapability` | Last/current session time and area |
| Quirks | `QuirksCapability` | Toggle settings: auto-collect, room cleaning preferences |

## Connection Model

### ROS services

`PersistentServiceClient` is used per service. Persistent connections are used
for frequently-polled services; short-lived connections are used for infrequent
command services to avoid holding sockets open.

| Service | ROS endpoint | Connection |
|---|---|---|
| map | `/map/GetCurrentCompressMap` | persistent |
| room/spot area | `/map/ManipulateSpotArea` | persistent |
| charger pose | `/map/ManipulateCharger` | persistent |
| trace | `/map/ManipulateTrace` | persistent |
| virtual walls | `/map/ManipulateVirtualWall` | short-lived |
| work control | `/task/WorkManage` | short-lived |
| settings | `/setting/SettingManage` | short-lived |
| lifespan | `/lifespan/lifespan` | short-lived |
| total statistics | `/worklog/GetLogInfo` | short-lived |
| last clean stats | `/worklog/GetLastLogInfo` | short-lived |

Each service definition lists multiple candidate endpoint names to handle
different firmware naming conventions. The first one that resolves via the
ROS master wins.

Behavior:

- Resolve endpoint via ROS master XML-RPC.
- Open one TCPROS socket and keep it open (persistent) or open/close per call (short-lived).
- Serialize calls with an internal lock.
- On failure, reset socket and reconnect transparently.

### ROS topics

`PredictionPoseSubscriber` keeps a long-lived TCPROS subscription to:

1. `/prediction/UpdatePose`
2. `/prediction/PredictPose` (fallback)
3. `/prediction/Pose` (fallback)

If the stream dies, it reconnects in a loop and keeps the latest fresh pose in memory.

`TopicStateSubscriber` keeps long-lived subscriptions to:

- `/task/WorkState` (robot work lifecycle: idle/running/paused + worktype)
- `/power/Battery`
- `/power/ChargeState`
- `/worklog/WorkStatisticToWifi` (live cleaning time/area during active sessions)

These topic values are used to keep Valetudo status and battery attributes in sync,
including reporting `docked` when the robot is on the charger.

The WorkStatistic subscriber uses `safeResolve` mode, which resolves the topic
endpoint via `getSystemState` + `lookupNode` + `requestTopic` only. It never
calls `registerSubscriber`, which crashes the firmware's medusa process via an
unexpected `publisherUpdate` callback. This topic only has publishers during
active cleaning; when idle, the subscriber retries every 10 seconds.

### Local non-ROS commands

`MdsctlClient` is used for:

- remote session open/close
- robot sounds (`locate`, `beep`, custom sound id)

## Command Mapping

### Basic Control

- `start` -> `WorkManage START + AUTO_CLEAN`
- `stop` -> `WorkManage STOP + IDLE`
- `pause` -> `WorkManage PAUSE + AUTO_CLEAN`
- `home` -> `WorkManage START + RETURN`

### Manual Control

- `remote-forward/backward/stop` -> `WorkManage START + REMOTE_CONTROL`
- `remote-turn-left/right` -> `REMOTE_MOVE_MVA_CUSTOM` with signed `w`
- hold commands -> repeated remote command + final stop
- session open/close -> `mdsctl` calls (`live_pwd`, `rosnode`)

### Settings via SettingManage

| Setting | settingType | Description |
|---|---|---|
| Suction boost on carpet | 8 | Toggle carpet auto-boost |
| Water level | 6 | Global mopping water level |
| Fan level | 7 | Global suction power |
| Auto-collect | 13 | Auto dust bin emptying |
| Room preferences toggle | 14 | Enable per-room cleaning preferences |
| Cleaning times | 15 | Global cleaning passes |

Note: `SettingManage` request uses two trailing padding bytes to match device behavior.

### Per-Room Cleaning Preferences

Read via `ManipulateSpotArea` GET response (preferences are embedded in the
metadata gap after each room's polygon data). Written via `ManipulateSpotArea`
SET with `type=4` (17-byte header + 30-byte room block per room).

Per-room settings: suction power, water level, cleaning times.

### Room Cleaning Order

Read via `ManipulateSpotArea` GET response (sequence position is a `u8` byte
in the room metadata gap, immediately after the cleaning preferences). Written
via `ManipulateSpotArea` SET with `type=5` (17-byte header + 30-byte room block
per room, with `areaid` at byte 0 and `sequence_position` at byte 29).

### Virtual Restrictions

Read/written via `ManipulateVirtualWall`:

- **No-go zones**: 4-dot rectangular areas, `type=0`
- **No-mop zones**: 4-dot rectangular areas, `type=1`
- **Virtual walls (lines)**: 2-dot line segments, `type=0`

## Map and Entities

- Room polygons + room metadata from `ManipulateSpotArea`
- Compressed map raster from `GetCurrentCompressMap`
- Charger pose from `ManipulateCharger`
- Live robot pose from `/prediction/*` topics
- Trace path from `ManipulateTrace`
- Virtual walls/zones from `ManipulateVirtualWall`
- Consumable lifespan from `/lifespan/lifespan`

Full map polls rebuild layers (including room preferences and cleaning order),
while the live refresh loop updates only entities (robot, charger, trace path).

Room cleaning preferences and sequence data are cached on the robot instance
(`cachedRoomCleaningPreferences`) so that the UI reflects values immediately
after writes, before the next full map poll arrives.

### Room identification (`areaid`)

Each room in the firmware has a unique `areaid` (u32). This value is used as
Valetudo's `segmentId` — it appears in the UI, in API requests (rename, clean,
merge, split, preferences), and in map layers.

The `areaid` is extracted from the `GET_SPOTAREAS` binary response by the
deterministic polygon parser in `EcovacsSpotAreaService.js`. The room block layout
before each polygon is:

```
areaid(u32) + name_len(u32) + name(bytes) + label_id(u8) + point_count(u32) + polygon...
```

On this firmware `name_len` is always 0 (room names are stored as label enum
IDs, not strings), so the `areaid` sits at a fixed offset of **9 bytes before
`point_count`**. The parser derives it from the polygon position rather than
from a sequential cursor, because the cursor only advances to end-of-polygon
and does not skip past post-polygon data (connections + preferences). Reading
at the cursor for rooms after the first would incorrectly read the previous
room's `connections_count` instead of the real `areaid`.

After merge or split operations the firmware reassigns `areaid`s — it may
recycle previously released values or allocate new ones. Valetudo re-reads
rooms after these operations to pick up the new identifiers.

## Adding New Features

When adding a new Ecovacs feature:

1. Add request/response serializer/parser logic in the appropriate domain service under `ros/services/` (e.g., `EcovacsSettingService.js` for settings, `EcovacsWorkManageService.js` for cleaning commands).
2. Reuse existing `PersistentServiceClient` where possible, add a new one only when needed.
3. Expose one high-level method on the service with typed arguments/return shape.
4. Call that method from the relevant capability or robot orchestration code via `this.robot.<serviceName>`.
5. Keep transformation/rendering helpers in separate module-level functions, not inline in capability code.

## Configuration Keys

All keys live under `robot.implementationSpecificConfig`.

### ROS connection

| Key | Default | Description |
|---|---|---|
| `rosMasterUri` | `$ROS_MASTER_URI` or `http://127.0.0.1:11311` | ROS master XML-RPC URI |
| `rosCallerId` | `$ROS_CALLER_ID` or `/ROSNODE` | Caller ID sent in TCPROS handshakes |
| `rosConnectTimeoutMs` | `4000` | TCP connect timeout for service/topic sockets |
| `rosCallTimeoutMs` | `6000` | Timeout for individual service calls |
| `rosDebug` | `true` | Log ROS connect/call/response details at debug level |

### mdsctl

| Key | Default | Description |
|---|---|---|
| `mdsctlBinaryPath` | `$MDSCTL_PATH` or `mdsctl` | Path to the `mdsctl` binary on the robot |
| `mdsctlSocketPath` | `$MDS_CMD_SOCKET` or `/tmp/mds_cmd.sock` | Unix socket path for `mdsctl` |
| `mdsctlTimeoutMs` | `2000` | Timeout for `mdsctl` commands |
| `manualControlSessionCode` | *(none)* | Session code for remote control sessions (required for manual control) |

### Map rendering

| Key | Default | Description |
|---|---|---|
| `detailedMapRotationDegrees` | `270` | Clockwise rotation applied to the compressed raster |
| `detailedMapWorldMmPerPixel` | `50` | World-space mm per raster pixel |
| `detailedMapMaxLayerPixels` | `120000` | Max pixels per map layer before skipping detailed upgrade |
| `detailedMapMinFloorPixels` | `1000` | Min floor pixels required for detailed map to be valid |
| `detailedMapRefreshIntervalMs` | `120000` | How often to re-fetch the compressed raster map |

### Polling intervals

| Key | Default | Description |
|---|---|---|
| `livePositionPollIntervalMs` | `1500` | Pose + charger + entity refresh interval |
| `livePositionCommandTimeoutMs` | `4000` | Timeout for a single live-position poll cycle |
| `powerStatePollIntervalMs` | `3000` | Battery + charge state topic poll interval |
| `cleaningSettingsPollIntervalMs` | `30000` | Global cleaning settings refresh interval |
| `powerStateStaleAfterMs` | `300000` | Consider power state stale after this duration |
| `workStateStaleAfterMs` | `20000` | Consider work state stale after this duration |

### Trace path

| Key | Default | Description |
|---|---|---|
| `tracePathEnabled` | `true` | Fetch and display the robot's cleaning trace |
| `tracePointUnitMm` | `10` | Coordinate unit of trace points (robot reports in 0.1mm) |
| `tracePathMaxPoints` | `2000` | Max trace points to keep in the path entity |
| `traceTailEntries` | `1` | Number of trace tail entries to request |

### State persistence

| Key | Default | Description |
|---|---|---|
| `runtimeStateCachePath` | `/tmp/valetudo_ecovacs_runtime_state.json` | File path for persisting runtime state across restarts |
| `runtimeStateCacheWriteMinIntervalMs` | `5000` | Min interval between state cache writes |

### Minimal config example

When running on the robot itself, most defaults are correct out of the box.
A minimal `valetudo.json` only needs the robot implementation and a manual
control session code (if manual control is desired):

```json
{
  "embedded": true,
  "robot": {
    "implementation": "EcovacsT8AiviValetudoRobot",
    "implementationSpecificConfig": {
      "manualControlSessionCode": "<your remote control code>",
      "rosDebug": false
    }
  }
}
```

### Running

Save the config as `valetudo_config.json` and point Valetudo at it.
Use a subshell with output redirected so it survives SSH disconnects:

```sh
(VALETUDO_CONFIG_PATH=/data/valetudo_config.json /data/valetudo > /tmp/valetudo_stdout.log 2>&1 &)
```

The parentheses run the command in a subshell. The `&` backgrounds it
within that subshell, so the child is not part of the terminal's process
group and won't receive SIGHUP when the SSH session ends.

Without output redirection, disconnecting the SSH session kills the
controlling TTY. Any subsequent write to stdout/stderr (e.g. from
`execSync` in NTP time sync) will fail with `EIO` and crash the process.

The robot uses BusyBox, which has neither `nohup` nor `setsid`.

Valetudo writes its own application log to `/tmp/valetudo.log`.
The `valetudo_stdout.log` file captures any additional output that goes
directly to stdout/stderr.

For a startup script (no TTY), `setsid` is not needed - just redirect and
background:

```sh
VALETUDO_CONFIG_PATH=/data/valetudo_config.json /data/valetudo > /tmp/valetudo_stdout.log 2>&1 &
```

To auto-restart on crash, wrap it in a loop:

```sh
#!/bin/sh
while true; do
    VALETUDO_CONFIG_PATH=/data/valetudo_config.json /data/valetudo > /tmp/valetudo_stdout.log 2>&1
    echo "Valetudo exited with code $?, restarting in 5s..." >> /tmp/valetudo_stdout.log
    sleep 5
done &
```

When running directly on the robot, the ROS master and `mdsctl` defaults
will work without any extra environment variables.
