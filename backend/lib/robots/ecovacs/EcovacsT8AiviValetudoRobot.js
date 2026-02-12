const capabilities = require("./capabilities");
const childProcess = require("child_process");
const entities = require("../../entities");
const fs = require("fs");
const Logger = require("../../Logger");
const mapEntities = require("../../entities/map");
const path = require("path");
const ValetudoRobot = require("../../core/ValetudoRobot");

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
        this.manualControlSessionCode = implementationSpecificConfig.manualControlSessionCode;
        this.manualControlActiveFlag = false;
        this.lastRobotPose = null;
        this.lastRobotPoseAt = 0;

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

        try {
            await this.runMapCommand(["rooms", "--mapid", "0"], {
                ROS_SPOT_AREA_JSON_OUT: roomDumpPath
            });
            const roomDumpRaw = fs.readFileSync(roomDumpPath).toString();
            const roomDump = JSON.parse(roomDumpRaw);

            if (!Array.isArray(roomDump.rooms) || roomDump.rooms.length === 0) {
                throw new Error("No room polygons returned by ros_map.py");
            }

            let positions = undefined;
            try {
                const positionsOut = await this.runMapCommand(["positions", "--mapid", "0"]);
                if (positionsOut.stdout) {
                    positions = parseFirstJSONObject(positionsOut.stdout);
                }
            } catch (e) {
                // Positions are optional for this first map integration step.
            }

            this.updateRobotPoseFromPositions(positions);
            this.state.map = this.buildMapFromRooms(roomDump.rooms, positions, this.getCurrentRobotPoseOrNull());
            this.emitMapUpdated();
        } catch (e) {
            Logger.warn("Failed to poll Ecovacs map", e);
            throw e;
        } finally {
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
     * @returns {import("../../entities/map/ValetudoMap")}
     */
    buildMapFromRooms(rooms, positions, robotPose) {
        const pixelSizeCm = this.mapPixelSizeCm;
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

        const floorPixels = Array.from(floorPixelSet).map(entry => {
            const [x, y] = entry.split(":");

            return [Number(x), Number(y)];
        });

        const layers = [];
        if (floorPixels.length > 0) {
            layers.push(new mapEntities.MapLayer({
                type: mapEntities.MapLayer.TYPE.FLOOR,
                pixels: floorPixels.sort(mapEntities.MapLayer.COORDINATE_TUPLE_SORT).flat()
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

        const mapWidthCm = (Math.ceil((maxX - minX + 2 * marginCm) / pixelSizeCm) + 1) * pixelSizeCm;
        const mapHeightCm = (Math.ceil((maxY - minY + 2 * marginCm) / pixelSizeCm) + 1) * pixelSizeCm;

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
