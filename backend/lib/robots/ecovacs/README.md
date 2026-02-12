# Ecovacs Backend Architecture

This directory contains the Ecovacs robot backend implementation for Valetudo.

The current implementation uses native JavaScript ROS TCP/XML-RPC clients and
does not rely on Python helper scripts for runtime robot control.

## Design Goals

- Keep ROS connections persistent to avoid connect/setup overhead per command.
- Hide reconnect logic from capability and robot orchestration code.
- Keep protocol code modular and small instead of one monolithic file.
- Make feature additions (for example, boundaries) straightforward.

## Module Layout

- `EcovacsT8AiviValetudoRobot.js`
  - Main robot orchestration and map rendering logic.
  - Delegates ROS and `mdsctl` work to service modules.
- `capabilities/*`
  - Valetudo capability adapters (basic control, manual control, locate, carpet mode).
- `ros/protocol/*`
  - Low-level binary/TCPROS helpers.
- `ros/core/*`
  - Reusable connection and endpoint discovery primitives.
- `ros/services/EcovacsRosFacade.js`
  - High-level Ecovacs operations mapped to ROS requests/responses.
- `ros/services/MdsctlClient.js`
  - Local `mdsctl` command execution wrapper.

## Connection Model

### ROS services

`PersistentServiceClient` is used per service:

- map: `/map/GetCurrentCompressMap`
- room/spot area: `/map/ManipulateSpotArea`
- charger pose: `/map/ManipulateCharger`
- trace: `/map/ManipulateTrace`
- virtual walls: `/map/ManipulateVirtualWall`
- work control: `/task/WorkManage`
- settings: `/setting/SettingManage`

Behavior:

- Resolve endpoint via ROS master XML-RPC.
- Open one TCPROS socket and keep it open.
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

These topic values are used to keep Valetudo status and battery attributes in sync,
including reporting `docked` when the robot is on the charger.

### Local non-ROS commands

`MdsctlClient` is used for:

- remote session open/close
- robot sounds (`locate`, `beep`, custom sound id)

## Command Mapping

## Basic Control

- `start` -> `WorkManage START + AUTO_CLEAN`
- `stop` -> `WorkManage STOP + IDLE`
- `pause` -> `WorkManage PAUSE + AUTO_CLEAN`
- `home` -> `WorkManage START + RETURN`

## Manual Control

- `remote-forward/backward/stop` -> `WorkManage START + REMOTE_CONTROL`
- `remote-turn-left/right` -> `REMOTE_MOVE_MVA_CUSTOM` with signed `w`
- hold commands -> repeated remote command + final stop
- session open/close -> `mdsctl` calls (`live_pwd`, `rosnode`)

## Settings

- suction boost on carpet (`settingType=8`) via `SettingManage`
- room preferences toggle (`settingType=14`) via `SettingManage`

Note: `SettingManage` request uses two trailing padding bytes to match device behavior.

## Map and Entities

- room polygons + room metadata from `ManipulateSpotArea`
- compressed map raster from `GetCurrentCompressMap`
- charger pose from `ManipulateCharger`
- live robot pose from `/prediction/*` topics
- trace path from `ManipulateTrace`

Full map polls rebuild layers, while the live refresh loop updates only entities (robot, charger, trace path).

## Adding New Features

When adding a new Ecovacs feature:

1. Add request/response serializer/parser logic in `ros/services/EcovacsRosFacade.js`.
2. Reuse existing `PersistentServiceClient` where possible, add a new one only when needed.
3. Expose one high-level facade method with typed arguments/return shape.
4. Call that method from the relevant capability or robot orchestration code.
5. Keep transformation/rendering helpers in separate functions, not inline in capability code.

For virtual restriction UI support:

- Use the existing virtual wall facade methods as protocol primitives.
- Add a dedicated capability adapter that translates Valetudo restriction entities
  to/from Ecovacs virtual wall rectangles.
- Keep conversion logic in the capability layer, not in low-level protocol modules.

## Configuration Keys

Implementation-specific keys currently used:

- `rosMasterUri`
- `rosCallerId`
- `rosConnectTimeoutMs`
- `rosCallTimeoutMs`
- `mdsctlBinaryPath`
- `mdsctlSocketPath`
- `mdsctlTimeoutMs`

Map/render tuning keys in the robot class remain unchanged.
