const capabilities = require("./capabilities");
const childProcess = require("child_process");
const entities = require("../../entities");
const fs = require("fs");
const Logger = require("../../Logger");
const lzma = require("lzma-purejs");
const mapEntities = require("../../entities/map");
const path = require("path");
const ValetudoRobot = require("../../core/ValetudoRobot");
require("./lzmaPurejsPkgIncludes");

const stateAttrs = entities.state.attributes;

class EcovacsT8AiviValetudoRobot extends ValetudoRobot {
    /**
     * @param {object} options
     * @param {import("../../Configuration")} options.config
     * @param {import("../../ValetudoEventStore")} options.valetudoEventStore
     */
    constructor(options) {
        super(options);

        const implementationSpecificConfig = options.config.get("robot")?.implementationSpecificConfig ?? {};

        this.pythonBinary = implementationSpecificConfig.pythonBinary ?? "python2";
        this.scriptBasePath = implementationSpecificConfig.scriptBasePath ?? "/data";
        this.startCleanScript = implementationSpecificConfig.startCleanScript ?? "ros_start_clean.py";
        this.settingsScript = implementationSpecificConfig.settingsScript ?? "ros_settings.py";
        this.soundScript = implementationSpecificConfig.soundScript ?? "ros_sound.py";
        this.mapScript = implementationSpecificConfig.mapScript ?? "ros_map.py";
        this.scriptTimeoutMs = implementationSpecificConfig.scriptTimeoutMs ?? 15_000;
        this.mapPixelSizeCm = implementationSpecificConfig.mapPixelSizeCm ?? 5;
        this.robotPoseStaleAfterMs = implementationSpecificConfig.robotPoseStaleAfterMs ?? 10_000;
        this.detailedMapUpgradeEnabled = implementationSpecificConfig.detailedMapUpgradeEnabled ?? false;
        this.detailedMapMaxLayerPixels = implementationSpecificConfig.detailedMapMaxLayerPixels ?? 900_000;
        this.detailedMapMinFloorPixels = implementationSpecificConfig.detailedMapMinFloorPixels ?? 1_000;
        this.detailedMapMinFloorCoverageRatio = implementationSpecificConfig.detailedMapMinFloorCoverageRatio ?? 0.2;
        this.detailedMapRefreshIntervalMs = implementationSpecificConfig.detailedMapRefreshIntervalMs ?? 120_000;
        this.detailedMapRotationDegrees = implementationSpecificConfig.detailedMapRotationDegrees ?? 270;
        this.detailedMapWorldMmPerPixel = implementationSpecificConfig.detailedMapWorldMmPerPixel ?? 50;
        this.manualControlSessionCode = implementationSpecificConfig.manualControlSessionCode;
        this.manualControlActiveFlag = false;
        this.lastRobotPose = null;
        this.lastRobotPoseAt = 0;
        this.cachedCompressedMap = null;
        this.cachedCompressedMapAt = 0;

        this.state.upsertFirstMatchingAttribute(new stateAttrs.DockStatusStateAttribute({
            value: stateAttrs.DockStatusStateAttribute.VALUE.IDLE
        }));
        this.setStatus(stateAttrs.StatusStateAttribute.VALUE.IDLE);

        this.registerCapability(new capabilities.EcovacsBasicControlCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsManualControlCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsLocateCapability({robot: this}));
        this.registerCapability(new capabilities.EcovacsCarpetModeControlCapability({robot: this}));
    }

    getManufacturer() {
        return "Ecovacs";
    }

    getModelName() {
        return "T8 AIVI";
    }

    startup() {
        super.startup();

        Logger.info(`Ecovacs script base path: ${this.scriptBasePath}`);
        Logger.info(`Ecovacs python binary: ${this.pythonBinary}`);

        setTimeout(() => {
            this.pollMap();
        }, 2000);
    }

    /**
     * @returns {Promise<void>}
     */
    async executeMapPoll() {
        const roomDumpPath = `/tmp/valetudo_ecovacs_rooms_${Date.now()}_${Math.round(Math.random() * 1e6)}.json`;
        const pollStartedAt = Date.now();

        try {
            Logger.debug("Ecovacs map poll: fetching rooms");
            await this.runMapCommand(["rooms", "--mapid", "0"], {
                ROS_SPOT_AREA_JSON_OUT: roomDumpPath
            });
            const roomDumpRaw = fs.readFileSync(roomDumpPath).toString();
            const roomDump = JSON.parse(roomDumpRaw);

            if (!Array.isArray(roomDump.rooms) || roomDump.rooms.length === 0) {
                throw new Error("No room polygons returned by ros_map.py");
            }
            Logger.debug(`Ecovacs map poll: rooms fetched (${roomDump.rooms.length})`);

            let positions = undefined;
            try {
                Logger.debug("Ecovacs map poll: fetching positions");
                const positionsOut = await this.runMapCommand(["positions", "--mapid", "0"]);
                if (positionsOut.stdout) {
                    positions = parseFirstJSONObject(positionsOut.stdout);
                    Logger.debug("Ecovacs map poll: positions fetched");
                }
            } catch (e) {
                // Positions are optional for this first map integration step.
                Logger.warn("Ecovacs map poll: positions unavailable", e?.message ?? e);
            }

            this.updateRobotPoseFromPositions(positions);

            const simplifiedMap = this.buildMapFromRooms(
                roomDump.rooms,
                positions,
                this.getCurrentRobotPoseOrNull()
            );
            Logger.info(`Ecovacs map poll: simplified map stats ${formatMapStats(simplifiedMap)}`);

            // Publish only detailed map in normal flow.
            const mapDumpDir = `/tmp/valetudo_ecovacs_map_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
            try {
                const detailedMapStart = Date.now();
                let compressedMap = this.cachedCompressedMap;
                const cacheAgeMs = Date.now() - this.cachedCompressedMapAt;
                const cacheValid = compressedMap !== null && cacheAgeMs >= 0 && cacheAgeMs < this.detailedMapRefreshIntervalMs;
                if (cacheValid) {
                    Logger.debug(`Ecovacs map poll: using cached compressed map (${cacheAgeMs}ms old)`);
                } else {
                    Logger.debug("Ecovacs map poll: fetching compressed map dump");
                    const getOut = await this.runMapCommandWithTimeout(
                        ["get", "--mapid", "0", "--out-dir", mapDumpDir],
                        Math.min(this.scriptTimeoutMs, 7_000)
                    );
                    Logger.debug("Ecovacs map poll: decoding compressed submaps");
                    compressedMap = decodeCompressedMapDump(mapDumpDir, getOut.stdout);
                    this.cachedCompressedMap = compressedMap;
                    this.cachedCompressedMapAt = Date.now();
                    Logger.debug(
                        `Ecovacs map poll: decoded compressed map (${compressedMap.width}x${compressedMap.height})`
                    );
                }
                const detailedMap = this.buildDetailedMapAlignedToSimplified(
                    roomDump.rooms,
                    positions,
                    this.getCurrentRobotPoseOrNull(),
                    compressedMap
                );
                const detailedPixels = getTotalLayerPixelCount(detailedMap);
                const simpleFloorPixels = getLayerPixelCountByType(simplifiedMap, mapEntities.MapLayer.TYPE.FLOOR);
                const detailedFloorPixels = getLayerPixelCountByType(detailedMap, mapEntities.MapLayer.TYPE.FLOOR);
                const floorCoverageRatio = simpleFloorPixels > 0 ? (detailedFloorPixels / simpleFloorPixels) : 0;
                Logger.info(`Ecovacs map poll: detailed map stats ${formatMapStats(detailedMap)}`);
                if (detailedPixels > this.detailedMapMaxLayerPixels) {
                    Logger.warn(
                        `Ecovacs map poll: detailed map too large (${detailedPixels} px > ${this.detailedMapMaxLayerPixels} px), keeping simplified map`
                    );
                    return;
                }
                if (detailedFloorPixels < this.detailedMapMinFloorPixels) {
                    Logger.warn(
                        `Ecovacs map poll: detailed floor too small (${detailedFloorPixels} px < ${this.detailedMapMinFloorPixels} px), keeping simplified map`
                    );
                    return;
                }
                if (floorCoverageRatio < this.detailedMapMinFloorCoverageRatio) {
                    Logger.warn(
                        `Ecovacs map poll: detailed floor coverage too low (${floorCoverageRatio.toFixed(3)} < ${this.detailedMapMinFloorCoverageRatio}), using simplified fallback`
                    );
                    this.state.map = simplifiedMap;
                    this.emitMapUpdated();
                    return;
                }
                this.state.map = detailedMap;
                this.emitMapUpdated();
                Logger.info(`Ecovacs map poll: detailed map upgraded in ${Date.now() - detailedMapStart}ms`);
            } catch (e) {
                Logger.warn("Ecovacs map poll: detailed map unavailable, using simplified fallback", e?.message ?? e);
                this.state.map = simplifiedMap;
                this.emitMapUpdated();
            } finally {
                try {
                    fs.rmSync(mapDumpDir, {recursive: true, force: true});
                } catch (e) {
                    // ignore temp dir cleanup errors
                }
            }
        } catch (e) {
            Logger.warn("Failed to poll Ecovacs map", e);
            throw e;
        } finally {
            Logger.debug(`Ecovacs map poll: done in ${Date.now() - pollStartedAt}ms`);
            try {
                fs.unlinkSync(roomDumpPath);
            } catch (e) {
                // ignore temp file cleanup errors
            }
        }
    }

    setStatus(value, flag) {
        this.state.upsertFirstMatchingAttribute(new stateAttrs.StatusStateAttribute({
            value: value,
            flag: flag ?? stateAttrs.StatusStateAttribute.FLAG.NONE
        }));
        this.emitStateAttributesUpdated();
    }

    getManualControlSessionCode() {
        if (this.manualControlSessionCode === undefined || this.manualControlSessionCode === null || this.manualControlSessionCode === "") {
            throw new Error(
                "Missing robot.implementationSpecificConfig.manualControlSessionCode for Ecovacs manual control session setup."
            );
        }

        return this.manualControlSessionCode;
    }

    /**
     * @param {Array<string>} args
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runStartCleanCommand(args) {
        return this.runPythonScript(this.startCleanScript, args);
    }

    /**
     * @param {Array<string>} args
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runSettingsCommand(args) {
        return this.runPythonScript(this.settingsScript, args);
    }

    /**
     * @param {Array<string>} args
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runSoundCommand(args) {
        return this.runPythonScript(this.soundScript, args);
    }

    /**
     * @param {Array<string>} args
     * @param {object} [envOverrides]
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runMapCommand(args, envOverrides) {
        return this.runPythonScript(this.mapScript, args, envOverrides);
    }

    /**
     * @param {Array<string>} args
     * @param {number} timeoutMs
     * @param {object} [envOverrides]
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runMapCommandWithTimeout(args, timeoutMs, envOverrides) {
        if (this.config.get("embedded") !== true) {
            throw new Error("Ecovacs script execution is only supported in embedded mode.");
        }

        const scriptPath = path.isAbsolute(this.mapScript) ? this.mapScript : path.join(this.scriptBasePath, this.mapScript);
        const commandEnv = Object.assign({}, process.env, envOverrides ?? {});

        return this.runCommand(this.pythonBinary, [scriptPath].concat(args), timeoutMs, commandEnv);
    }

    /**
     * @private
     * @param {string} scriptName
     * @param {Array<string>} args
     * @param {object} [envOverrides]
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runPythonScript(scriptName, args, envOverrides) {
        if (this.config.get("embedded") !== true) {
            throw new Error("Ecovacs script execution is only supported in embedded mode.");
        }

        const scriptPath = path.isAbsolute(scriptName) ? scriptName : path.join(this.scriptBasePath, scriptName);
        const commandEnv = Object.assign({}, process.env, envOverrides ?? {});

        return this.runCommand(this.pythonBinary, [scriptPath].concat(args), this.scriptTimeoutMs, commandEnv);
    }

    /**
     * @private
     * @param {string} command
     * @param {Array<string>} args
     * @param {number} timeoutMs
     * @param {object} [commandEnv]
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runCommand(command, args, timeoutMs, commandEnv) {
        return new Promise((resolve, reject) => {
            const child = childProcess.spawn(command, args, {
                env: commandEnv
            });
            let stdout = "";
            let stderr = "";
            let timedOut = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
            }, timeoutMs);

            child.stdout.on("data", chunk => {
                stdout += chunk.toString();
            });
            child.stderr.on("data", chunk => {
                stderr += chunk.toString();
            });

            child.once("error", err => {
                clearTimeout(timeout);
                reject(err);
            });

            child.once("close", code => {
                clearTimeout(timeout);

                if (timedOut) {
                    reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
                    return;
                }

                if (code !== 0) {
                    reject(new Error(
                        `Command failed (exit ${code}): ${command} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`
                    ));
                    return;
                }

                resolve({
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                });
            });
        });
    }

    /**
     * @private
     * @param {Array<any>} rooms
     * @param {any} positions
     * @param {{x:number,y:number,angle:number}|null} robotPose
     * @param {object} [compressedMap]
     * @returns {import("../../entities/map/ValetudoMap")}
     */
    buildMapFromRooms(rooms, positions, robotPose, compressedMap) {
        const pixelSizeCm = compressedMap?.resolutionCm ?? this.mapPixelSizeCm;
        const parsedRooms = rooms.map(room => {
            const polygon = Array.isArray(room.polygon) ? room.polygon : [];

            return {
                index: String(room.index ?? "0"),
                labelName: room.label_name ?? `Room ${room.index ?? 0}`,
                polygonCm: polygon.map(point => {
                    return {
                        x: Math.round(Number(point[0]) / 10),
                        y: Math.round(Number(point[1]) / 10)
                    };
                })
            };
        }).filter(room => room.polygonCm.length >= 3);

        const allX = parsedRooms.flatMap(room => room.polygonCm.map(p => p.x));
        const allY = parsedRooms.flatMap(room => room.polygonCm.map(p => p.y));
        const minX = Math.min(...allX);
        const maxX = Math.max(...allX);
        const minY = Math.min(...allY);
        const maxY = Math.max(...allY);
        const marginCm = pixelSizeCm * 4;
        const mapWidthPx = Math.ceil((maxX - minX + 2 * marginCm) / pixelSizeCm) + 1;
        const mapHeightPx = Math.ceil((maxY - minY + 2 * marginCm) / pixelSizeCm) + 1;

        const worldToGrid = (point) => {
            const shiftedX = point.x - minX + marginCm;
            const shiftedY = maxY - point.y + marginCm;

            return {
                x: Math.floor(shiftedX / pixelSizeCm),
                y: Math.floor(shiftedY / pixelSizeCm)
            };
        };

        const floorPixelSet = new Set();
        const segmentLayers = [];
        parsedRooms.forEach(room => {
            const gridPolygon = room.polygonCm.map(worldToGrid);
            const pixels = rasterizePolygon(gridPolygon);
            if (pixels.length === 0) {
                return;
            }

            pixels.forEach(pixel => {
                floorPixelSet.add(`${pixel[0]}:${pixel[1]}`);
            });

            segmentLayers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.SEGMENT,
                pixels: pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat(),
                metaData: {
                    segmentId: room.index,
                    name: room.labelName
                }
            }));
        });

        const roomFloorPixels = Array.from(floorPixelSet).map(entry => {
            const [x, y] = entry.split(":");

            return [Number(x), Number(y)];
        });
        const roomFloorSet = new Set(roomFloorPixels.map(([x, y]) => `${x}:${y}`));

        let rasterFloorPixels = roomFloorPixels;
        let rasterWallPixels = [];
        if (compressedMap) {
            try {
                const projected = projectCompressedMapToGrid(compressedMap, mapWidthPx, mapHeightPx, roomFloorSet);
                if (projected.floorPixels.length > 0) {
                    rasterFloorPixels = projected.floorPixels;
                }
                rasterWallPixels = projected.wallPixels;
            } catch (e) {
                Logger.warn("Failed to project compressed Ecovacs raster into room grid", e);
            }
        }

        const layers = [];
        if (rasterFloorPixels.length > 0) {
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.FLOOR,
                pixels: rasterFloorPixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
            }));
        }
        if (rasterWallPixels.length > 0) {
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.WALL,
                pixels: rasterWallPixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
            }));
        }
        layers.push(...segmentLayers);

        const mapItems = [];
        const chargerPose = positions?.charger?.pose;
        if (chargerPose && typeof chargerPose.x === "number" && typeof chargerPose.y === "number") {
            const chargerGrid = worldToGrid({
                x: Math.round(chargerPose.x / 10),
                y: Math.round(chargerPose.y / 10)
            });
            mapItems.push(new mapEntities.PointMapEntity({
                type: mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION,
                points: [
                    chargerGrid.x * pixelSizeCm,
                    chargerGrid.y * pixelSizeCm
                ]
            }));
        }
        if (robotPose) {
            const robotGrid = worldToGrid({
                x: Math.round(robotPose.x / 10),
                y: Math.round(robotPose.y / 10)
            });
            mapItems.push(new mapEntities.PointMapEntity({
                type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION,
                points: [
                    robotGrid.x * pixelSizeCm,
                    robotGrid.y * pixelSizeCm
                ],
                metaData: {
                    angle: Number.isFinite(robotPose.angle) ? robotPose.angle : 0
                }
            }));
        }

        const mapWidthCm = mapWidthPx * pixelSizeCm;
        const mapHeightCm = mapHeightPx * pixelSizeCm;

        return new mapEntities.ValetudoMap({
            size: {
                x: mapWidthCm,
                y: mapHeightCm
            },
            pixelSize: pixelSizeCm,
            layers: layers,
            entities: mapItems
        });
    }

    /**
     * Build detailed raster and overlays with the same transforms used by
     * scripts/decode_map_dump.py + scripts/render_rooms_overlay.py.
     *
     * @param {Array<any>} rooms
     * @param {any} positions
     * @param {{x:number,y:number,angle:number}|null} robotPose
     * @param {{width:number,height:number,resolutionCm:number,floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}} compressedMap
     * @returns {import("../../entities/map/ValetudoMap")}
     */
    buildDetailedMapAlignedToSimplified(rooms, positions, robotPose, compressedMap) {
        const pixelSizeCm = Number(compressedMap.resolutionCm);
        if (!Number.isFinite(pixelSizeCm) || pixelSizeCm <= 0) {
            throw new Error("Invalid compressed map pixel size");
        }
        const mapRotation = normalizeClockwiseRotation(this.detailedMapRotationDegrees);
        const mmPerPixel = Number(this.detailedMapWorldMmPerPixel);
        if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
            throw new Error("Invalid detailedMapWorldMmPerPixel");
        }

        const rotatedFloor = rotatePixelsClockwise(
            compressedMap.floorPixels,
            compressedMap.width,
            compressedMap.height,
            mapRotation
        );
        const rotatedWall = rotatePixelsClockwise(
            compressedMap.wallPixels,
            compressedMap.width,
            compressedMap.height,
            mapRotation
        );
        Logger.debug(
            `Ecovacs detailed map transform: rotation=${mapRotation}deg size=${rotatedFloor.width}x${rotatedFloor.height} mm_per_pixel=${mmPerPixel}`
        );

        const mapWidthPx = rotatedFloor.width;
        const mapHeightPx = rotatedFloor.height;
        const layers = [];

        if (rotatedFloor.pixels.length > 0) {
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.FLOOR,
                pixels: rotatedFloor.pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
            }));
        }
        if (rotatedWall.pixels.length > 0) {
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.WALL,
                pixels: rotatedWall.pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
            }));
        }

        for (const room of (Array.isArray(rooms) ? rooms : [])) {
            const polygon = Array.isArray(room?.polygon) ? room.polygon : [];
            const polygonGrid = polygon.map(point => {
                return worldToGridScriptCompatible(
                    Number(point?.[0]),
                    Number(point?.[1]),
                    mapWidthPx,
                    mapHeightPx,
                    mmPerPixel
                );
            }).filter(Boolean).map(point => {
                return clampPointToBounds(point, mapWidthPx, mapHeightPx);
            });
            if (polygonGrid.length < 3) {
                continue;
            }
            const pixels = rasterizePolygon(polygonGrid);
            if (pixels.length === 0) {
                continue;
            }
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.SEGMENT,
                pixels: pixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat(),
                metaData: {
                    segmentId: String(room.index ?? "0"),
                    name: room.label_name ?? `Room ${room.index ?? 0}`
                }
            }));
        }

        const entities = [];
        const chargerPose = positions?.charger?.pose;
        if (chargerPose && typeof chargerPose.x === "number" && typeof chargerPose.y === "number") {
            const chargerGrid = worldToGridScriptCompatible(
                Number(chargerPose.x),
                Number(chargerPose.y),
                mapWidthPx,
                mapHeightPx,
                mmPerPixel
            );
            if (chargerGrid) {
                entities.push(new mapEntities.PointMapEntity({
                    type: mapEntities.PointMapEntity.TYPE.CHARGER_LOCATION,
                    points: [
                        chargerGrid.x * pixelSizeCm,
                        chargerGrid.y * pixelSizeCm
                    ]
                }));
            }
        }
        if (robotPose) {
            const robotGrid = worldToGridScriptCompatible(
                Number(robotPose.x),
                Number(robotPose.y),
                mapWidthPx,
                mapHeightPx,
                mmPerPixel
            );
            if (robotGrid) {
                entities.push(new mapEntities.PointMapEntity({
                    type: mapEntities.PointMapEntity.TYPE.ROBOT_POSITION,
                    points: [
                        robotGrid.x * pixelSizeCm,
                        robotGrid.y * pixelSizeCm
                    ],
                    metaData: {
                        angle: Number.isFinite(robotPose.angle) ? robotPose.angle : 0
                    }
                }));
            }
        }

        return new mapEntities.ValetudoMap({
            size: {
                x: mapWidthPx * pixelSizeCm,
                y: mapHeightPx * pixelSizeCm
            },
            pixelSize: pixelSizeCm,
            layers: layers,
            entities: entities
        });
    }

    /**
     * @private
     * @param {any} positions
     */
    updateRobotPoseFromPositions(positions) {
        const directPose = positions?.robot?.pose;
        if (directPose && typeof directPose.x === "number" && typeof directPose.y === "number") {
            this.lastRobotPose = {
                x: directPose.x,
                y: directPose.y,
                angle: Number(directPose.theta ?? directPose.angle ?? 0)
            };
            this.lastRobotPoseAt = Date.now();
            return;
        }
    }

    /**
     * @private
     * @returns {{x:number,y:number,angle:number}|null}
     */
    getCurrentRobotPoseOrNull() {
        if (!this.lastRobotPose) {
            return null;
        }

        if (Date.now() - this.lastRobotPoseAt > this.robotPoseStaleAfterMs) {
            return null;
        }

        return this.lastRobotPose;
    }

    static IMPLEMENTATION_AUTO_DETECTION_HANDLER() {
        return fs.existsSync("/tmp/mds_cmd.sock") &&
            fs.existsSync("/usr/lib/python2.7/site-packages/task") &&
            fs.existsSync("/usr/lib/python2.7/site-packages/setting");
    }
}

/**
 * @param {Array<{x:number,y:number}>} polygon
 * @returns {Array<[number, number]>}
 */
function rasterizePolygon(polygon) {
    const minX = Math.min(...polygon.map(p => p.x));
    const maxX = Math.max(...polygon.map(p => p.x));
    const minY = Math.min(...polygon.map(p => p.y));
    const maxY = Math.max(...polygon.map(p => p.y));

    /** @type {Array<[number, number]>} */
    const pixels = [];
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            if (pointInPolygon(x + 0.5, y + 0.5, polygon)) {
                pixels.push([x, y]);
            }
        }
    }

    return pixels;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {Array<{x:number,y:number}>} polygon
 * @returns {boolean}
 */
function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;

        const intersects = ((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
        if (intersects) {
            inside = !inside;
        }
    }

    return inside;
}

module.exports = EcovacsT8AiviValetudoRobot;

/**
 * Parse JSON and tolerate surrounding log noise.
 *
 * @param {string} text
 * @returns {any}
 */
function parseFirstJSONObject(text) {
    const raw = String(text ?? "").trim();
    if (raw === "") {
        throw new Error("Empty JSON string");
    }

    try {
        return JSON.parse(raw);
    } catch (e) {
        // Fallback for occasional trailing shell noise after JSON.
        const firstBrace = raw.indexOf("{");
        const lastBrace = raw.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
        }

        throw e;
    }
}

/**
 * @param {string} dumpDir
 * @param {string} getStdout
 * @returns {{width:number,height:number,columns:number,rows:number,submapWidth:number,submapHeight:number,resolutionCm:number,floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}}
 */
function decodeCompressedMapDump(dumpDir, getStdout) {
    const decodeStartedAt = Date.now();
    const meta = parseCompressMapMeta(getStdout);
    const indexPath = path.join(dumpDir, "index.tsv");
    const rows = readDumpIndex(indexPath);
    const expectedSubmaps = meta.columns * meta.rows;
    if (rows.length < expectedSubmaps) {
        throw new Error(`Compressed map dump incomplete: expected ${expectedSubmaps}, got ${rows.length}`);
    }

    /** @type {Array<[number, number]>} */
    const floorPixels = [];
    /** @type {Array<[number, number]>} */
    const wallPixels = [];

    for (const row of rows) {
        const tileIndex = Number(row.index);
        if (!Number.isFinite(tileIndex) || tileIndex < 0) {
            continue;
        }
        const tilePath = path.join(dumpDir, row.file);
        const decoded = decodeEcovacsCompressedSubmap(fs.readFileSync(tilePath));
        const expectedTileLen = meta.submapWidth * meta.submapHeight;
        if (decoded.length !== expectedTileLen) {
            throw new Error(`Tile length mismatch in ${row.file}: ${decoded.length} != ${expectedTileLen}`);
        }

        const tileRow = Math.floor(tileIndex / meta.columns);
        const tileCol = tileIndex % meta.columns;
        const baseX = tileCol * meta.submapWidth;
        const baseY = tileRow * meta.submapHeight;

        for (let y = 0; y < meta.submapHeight; y++) {
            const srcOffset = y * meta.submapWidth;
            for (let x = 0; x < meta.submapWidth; x++) {
                const value = decoded[srcOffset + x];
                const mapX = baseX + x;
                const mapY = baseY + y;
                if (value === 1) {
                    floorPixels.push([mapX, mapY]);
                } else if (value === 2 || value === 255) {
                    wallPixels.push([mapX, mapY]);
                }
            }
        }
    }

    const result = {
        width: meta.width,
        height: meta.height,
        columns: meta.columns,
        rows: meta.rows,
        submapWidth: meta.submapWidth,
        submapHeight: meta.submapHeight,
        resolutionCm: inferCompressedMapPixelSizeCm(meta.resolutionRaw),
        floorPixels: floorPixels,
        wallPixels: wallPixels
    };
    Logger.debug(
        `Ecovacs compressed map decode: ${rows.length} submaps, floor=${floorPixels.length}, wall=${wallPixels.length}, took=${Date.now() - decodeStartedAt}ms`
    );

    return result;
}

/**
 * @param {Buffer} raw
 * @returns {Uint8Array}
 */
function decodeEcovacsCompressedSubmap(raw) {
    if (!Buffer.isBuffer(raw) || raw.length < 10) {
        throw new Error("Compressed submap payload is too short");
    }

    const propsAndDict = raw.subarray(0, 5);
    const uncompressedSize = raw.readUInt32LE(5);
    const lzmaPayload = raw.subarray(9);

    const lzmaAloneHeader = Buffer.alloc(13);
    propsAndDict.copy(lzmaAloneHeader, 0, 0, 5);
    lzmaAloneHeader.writeUInt32LE(uncompressedSize, 5);
    lzmaAloneHeader.writeUInt32LE(0, 9);

    const combined = Buffer.concat([lzmaAloneHeader, lzmaPayload]);
    const decoded = lzma.decompressFile(combined);
    const out = decoded instanceof Uint8Array ? decoded : Uint8Array.from(decoded);
    if (out.length !== uncompressedSize) {
        throw new Error(`Decoded submap length mismatch: ${out.length} != ${uncompressedSize}`);
    }

    return out;
}

/**
 * @param {string} stdout
 * @returns {{width:number,height:number,columns:number,rows:number,submapWidth:number,submapHeight:number,resolutionCm:number}}
 */
function parseCompressMapMeta(stdout) {
    const text = String(stdout ?? "");
    const metaMatch = text.match(
        /meta:\s*width=(\d+)\s+height=(\d+)\s+columns=(\d+)\s+rows=(\d+)\s+submapWidth=(\d+)\s+submapHeight=(\d+)\s+resolution_cm=(\d+)/
    );
    if (!metaMatch) {
        throw new Error(`Unable to parse compressed map metadata from ros_map.py output: ${text}`);
    }

    return {
        width: Number(metaMatch[1]),
        height: Number(metaMatch[2]),
        columns: Number(metaMatch[3]),
        rows: Number(metaMatch[4]),
        submapWidth: Number(metaMatch[5]),
        submapHeight: Number(metaMatch[6]),
        resolutionRaw: Number(metaMatch[7])
    };
}

/**
 * Ecovacs `resolution` is observed as 50 for 5cm maps.
 * Treat values >= 20 as millimeters, otherwise centimeters.
 *
 * @param {number} raw
 * @returns {number}
 */
function inferCompressedMapPixelSizeCm(raw) {
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
        return 5;
    }
    if (v >= 20) {
        return Math.max(1, Math.round(v / 10));
    }

    return Math.max(1, Math.round(v));
}

/**
 * @param {string} indexPath
 * @returns {Array<{index:string,file:string}>}
 */
function readDumpIndex(indexPath) {
    const raw = fs.readFileSync(indexPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) {
        return [];
    }

    const header = lines[0].split("\t");
    const indexIdx = header.indexOf("index");
    const fileIdx = header.indexOf("file");
    if (indexIdx < 0 || fileIdx < 0) {
        throw new Error(`Invalid compressed map index header in ${indexPath}`);
    }

    return lines.slice(1).map(line => {
        const cols = line.split("\t");

        return {
            index: cols[indexIdx],
            file: cols[fileIdx]
        };
    }).filter(entry => entry.file);
}

/**
 * @param {{width:number,height:number,floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}} compressedMap
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {Set<string>} roomFloorSet
 * @returns {{floorPixels:Array<[number,number]>,wallPixels:Array<[number,number]>}}
 */
function projectCompressedMapToGrid(compressedMap, targetWidth, targetHeight, roomFloorSet) {
    const projectionStartedAt = Date.now();
    const orientation = chooseBestProjectionOrientation(compressedMap, targetWidth, targetHeight, roomFloorSet);
    const floorSet = new Set();
    const wallSet = new Set();

    for (const [sx, sy] of compressedMap.floorPixels) {
        const p = projectSourcePointToTarget(sx, sy, compressedMap.width, compressedMap.height, targetWidth, targetHeight, orientation);
        if (p) {
            floorSet.add(`${p[0]}:${p[1]}`);
        }
    }
    for (const [sx, sy] of compressedMap.wallPixels) {
        const p = projectSourcePointToTarget(sx, sy, compressedMap.width, compressedMap.height, targetWidth, targetHeight, orientation);
        if (p) {
            wallSet.add(`${p[0]}:${p[1]}`);
        }
    }

    const result = {
        floorPixels: Array.from(floorSet).map(splitPixelKey),
        wallPixels: Array.from(wallSet).map(splitPixelKey)
    };
    Logger.debug(
        `Ecovacs compressed map projection: orientation=${orientation}, floor=${result.floorPixels.length}, wall=${result.wallPixels.length}, took=${Date.now() - projectionStartedAt}ms`
    );

    return result;
}

/**
 * @param {{width:number,height:number,floorPixels:Array<[number,number]>}} compressedMap
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {Set<string>} roomFloorSet
 * @returns {number}
 */
function chooseBestProjectionOrientation(compressedMap, targetWidth, targetHeight, roomFloorSet) {
    const maxSample = 4000;
    const step = Math.max(1, Math.floor(compressedMap.floorPixels.length / maxSample));

    let bestOrientation = 0;
    let bestScore = -1;
    for (let orientation = 0; orientation < 8; orientation++) {
        let score = 0;
        let checked = 0;
        for (let i = 0; i < compressedMap.floorPixels.length; i += step) {
            const [sx, sy] = compressedMap.floorPixels[i];
            const p = projectSourcePointToTarget(
                sx,
                sy,
                compressedMap.width,
                compressedMap.height,
                targetWidth,
                targetHeight,
                orientation
            );
            if (!p) {
                continue;
            }
            checked++;
            if (roomFloorSet.has(`${p[0]}:${p[1]}`)) {
                score++;
            }
        }
        const normalized = checked > 0 ? (score / checked) : 0;
        if (normalized > bestScore) {
            bestScore = normalized;
            bestOrientation = orientation;
        }
    }

    return bestOrientation;
}

/**
 * @param {number} sx
 * @param {number} sy
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @param {number} orientation
 * @returns {[number, number]|null}
 */
function projectSourcePointToTarget(sx, sy, srcWidth, srcHeight, targetWidth, targetHeight, orientation) {
    const transformed = orientPoint(sx, sy, srcWidth, srcHeight, orientation);
    if (!transformed) {
        return null;
    }
    const [ox, oy, ow, oh] = transformed;
    if (ow <= 1 || oh <= 1 || targetWidth <= 1 || targetHeight <= 1) {
        return null;
    }

    const tx = Math.round((ox / (ow - 1)) * (targetWidth - 1));
    const ty = Math.round((oy / (oh - 1)) * (targetHeight - 1));
    if (tx < 0 || ty < 0 || tx >= targetWidth || ty >= targetHeight) {
        return null;
    }

    return [tx, ty];
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} orientation
 * @returns {[number, number, number, number]|null}
 */
function orientPoint(x, y, width, height, orientation) {
    switch (orientation) {
        case 0:
            return [x, y, width, height];
        case 1:
            return [width - 1 - x, y, width, height];
        case 2:
            return [x, height - 1 - y, width, height];
        case 3:
            return [width - 1 - x, height - 1 - y, width, height];
        case 4:
            return [y, x, height, width];
        case 5:
            return [height - 1 - y, x, height, width];
        case 6:
            return [y, width - 1 - x, height, width];
        case 7:
            return [height - 1 - y, width - 1 - x, height, width];
        default:
            return null;
    }
}

/**
 * @param {string} key
 * @returns {[number, number]}
 */
function splitPixelKey(key) {
    const [x, y] = key.split(":");

    return [Number(x), Number(y)];
}

/**
 * @param {number} rotation
 * @returns {number}
 */
function normalizeClockwiseRotation(rotation) {
    const raw = Number(rotation);
    if (!Number.isFinite(raw)) {
        return 270;
    }
    const normalized = ((Math.round(raw) % 360) + 360) % 360;
    if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) {
        return normalized;
    }

    return 270;
}

/**
 * Rotate pixel tuples by 0/90/180/270 degrees clockwise.
 *
 * @param {Array<[number,number]>} pixels
 * @param {number} width
 * @param {number} height
 * @param {number} rotation
 * @returns {{pixels:Array<[number,number]>,width:number,height:number}}
 */
function rotatePixelsClockwise(pixels, width, height, rotation) {
    const inPixels = Array.isArray(pixels) ? pixels : [];
    const out = [];
    if (rotation === 0) {
        for (const [x, y] of inPixels) {
            out.push([x, y]);
        }

        return {pixels: out, width: width, height: height};
    }
    if (rotation === 180) {
        for (const [x, y] of inPixels) {
            out.push([width - 1 - x, height - 1 - y]);
        }

        return {pixels: out, width: width, height: height};
    }
    if (rotation === 90) {
        for (const [x, y] of inPixels) {
            out.push([height - 1 - y, x]);
        }

        return {pixels: out, width: height, height: width};
    }
    if (rotation === 270) {
        for (const [x, y] of inPixels) {
            out.push([y, width - 1 - x]);
        }

        return {pixels: out, width: height, height: width};
    }

    return {pixels: out, width: width, height: height};
}

/**
 * Same center-based transform as scripts/render_rooms_overlay.py.
 *
 * @param {number} worldXmm
 * @param {number} worldYmm
 * @param {number} mapWidthPx
 * @param {number} mapHeightPx
 * @param {number} mmPerPixel
 * @returns {{x:number,y:number}|null}
 */
function worldToGridScriptCompatible(worldXmm, worldYmm, mapWidthPx, mapHeightPx, mmPerPixel) {
    if (!Number.isFinite(worldXmm) || !Number.isFinite(worldYmm)) {
        return null;
    }
    const cx = mapWidthPx / 2.0;
    const cy = mapHeightPx / 2.0;

    return {
        x: Math.round(cx + (worldXmm / mmPerPixel)),
        y: Math.round(cy - (worldYmm / mmPerPixel))
    };
}

/**
 * @param {{x:number,y:number}} point
 * @param {number} width
 * @param {number} height
 * @returns {{x:number,y:number}}
 */
function clampPointToBounds(point, width, height) {
    return {
        x: Math.max(0, Math.min(width - 1, Math.round(point.x))),
        y: Math.max(0, Math.min(height - 1, Math.round(point.y)))
    };
}

/**
 * @param {import("../../entities/map/ValetudoMap")} map
 * @returns {number}
 */
function getTotalLayerPixelCount(map) {
    const layers = Array.isArray(map?.layers) ? map.layers : [];

    return layers.reduce((sum, layer) => {
        const px = Number(layer?.dimensions?.pixelCount ?? 0);

        return sum + (Number.isFinite(px) ? px : 0);
    }, 0);
}

/**
 * @param {import("../../entities/map/ValetudoMap")} map
 * @returns {string}
 */
function formatMapStats(map) {
    const widthCm = Number(map?.size?.x ?? 0);
    const heightCm = Number(map?.size?.y ?? 0);
    const pixelSize = Number(map?.pixelSize ?? 0);
    const layers = Array.isArray(map?.layers) ? map.layers : [];
    const entitiesCount = Array.isArray(map?.entities) ? map.entities.length : 0;
    const totalPixels = getTotalLayerPixelCount(map);
    const layerSummary = layers.map(layer => {
        const px = Number(layer?.dimensions?.pixelCount ?? 0);
        const cpx = Array.isArray(layer?.compressedPixels) ? layer.compressedPixels.length : 0;

        return `${layer.type}:${Number.isFinite(px) ? px : 0}(rle=${cpx})`;
    }).join(",");
    const payloadBytes = estimateMapPayloadBytes(map);

    return `size_cm=${widthCm}x${heightCm} pixel_cm=${pixelSize} layers=${layers.length} entities=${entitiesCount} layer_pixels=${totalPixels} payload_bytes=${payloadBytes} [${layerSummary}]`;
}

/**
 * @param {import("../../entities/map/ValetudoMap")} map
 * @returns {number}
 */
function estimateMapPayloadBytes(map) {
    try {
        return Buffer.byteLength(JSON.stringify(map), "utf8");
    } catch (e) {
        return -1;
    }
}

/**
 * @param {import("../../entities/map/ValetudoMap")} map
 * @param {string} layerType
 * @returns {number}
 */
function getLayerPixelCountByType(map, layerType) {
    const layers = Array.isArray(map?.layers) ? map.layers : [];

    return layers
        .filter(layer => layer?.type === layerType)
        .reduce((sum, layer) => {
            const px = Number(layer?.dimensions?.pixelCount ?? 0);

            return sum + (Number.isFinite(px) ? px : 0);
        }, 0);
}
