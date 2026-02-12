const capabilities = require("./capabilities");
const childProcess = require("child_process");
const entities = require("../../entities");
const fs = require("fs");
const Logger = require("../../Logger");
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
        this.scriptTimeoutMs = implementationSpecificConfig.scriptTimeoutMs ?? 15_000;
        this.manualControlSessionCode = implementationSpecificConfig.manualControlSessionCode;
        this.manualControlActiveFlag = false;

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
    }

    /**
     * @returns {Promise<void>}
     */
    async executeMapPoll() {
        return;
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
     * @private
     * @param {string} scriptName
     * @param {Array<string>} args
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runPythonScript(scriptName, args) {
        if (this.config.get("embedded") !== true) {
            throw new Error("Ecovacs script execution is only supported in embedded mode.");
        }

        const scriptPath = path.isAbsolute(scriptName) ? scriptName : path.join(this.scriptBasePath, scriptName);

        return this.runCommand(this.pythonBinary, [scriptPath].concat(args), this.scriptTimeoutMs);
    }

    /**
     * @private
     * @param {string} command
     * @param {Array<string>} args
     * @param {number} timeoutMs
     * @returns {Promise<{stdout: string, stderr: string}>}
     */
    async runCommand(command, args, timeoutMs) {
        return new Promise((resolve, reject) => {
            const child = childProcess.spawn(command, args);
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

    static IMPLEMENTATION_AUTO_DETECTION_HANDLER() {
        return fs.existsSync("/tmp/mds_cmd.sock") &&
            fs.existsSync("/usr/lib/python2.7/site-packages/task") &&
            fs.existsSync("/usr/lib/python2.7/site-packages/setting");
    }
}

module.exports = EcovacsT8AiviValetudoRobot;
