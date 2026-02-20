const entities = require("../../../entities");
const ManualControlCapability = require("../../../core/capabilities/ManualControlCapability");
const {
    REMOTE_MOVE_BACKWARD,
    REMOTE_MOVE_FORWARD,
    REMOTE_MOVE_MVA_CUSTOM,
    REMOTE_MOVE_STOP,
    REMOTE_TURN_W,
} = require("../EcovacsStateMapping");

const stateAttrs = entities.state.attributes;

/**
 * @extends ManualControlCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsManualControlCapability extends ManualControlCapability {
    constructor(options) {
        super(Object.assign({}, options, {
            supportedMovementCommands: [
                ManualControlCapability.MOVEMENT_COMMAND_TYPE.FORWARD,
                ManualControlCapability.MOVEMENT_COMMAND_TYPE.BACKWARD,
                ManualControlCapability.MOVEMENT_COMMAND_TYPE.ROTATE_CLOCKWISE,
                ManualControlCapability.MOVEMENT_COMMAND_TYPE.ROTATE_COUNTERCLOCKWISE
            ]
        }));
    }

    async enableManualControl() {
        if (this.robot.manualControlActiveFlag === true) {
            return;
        }

        const sessionCode = this.getSessionCode();
        await this.robot.remoteSessionService.open(sessionCode);

        this.robot.manualControlActiveFlag = true;
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.MANUAL_CONTROL);
    }

    async disableManualControl() {
        if (this.robot.manualControlActiveFlag === false) {
            return;
        }

        try {
            await this.robot.workManageService.remoteMove(REMOTE_MOVE_STOP);
        } catch (e) {
            // Stopping manual control session is more important than stop best-effort
        }

        await this.robot.remoteSessionService.close();

        this.robot.manualControlActiveFlag = false;
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.IDLE);
    }

    async manualControlActive() {
        return this.robot.manualControlActiveFlag;
    }

    /**
     * @param {import("../../../core/capabilities/ManualControlCapability").MOVEMENT_COMMAND_TYPE} movementCommand
     * @returns {Promise<void>}
     */
    async manualControl(movementCommand) {
        if (this.robot.manualControlActiveFlag !== true) {
            throw new Error("Manual control mode is not active.");
        }

        switch (movementCommand) {
            case ManualControlCapability.MOVEMENT_COMMAND_TYPE.FORWARD:
                await this.remoteHold(REMOTE_MOVE_FORWARD, 0, 0.35);
                break;
            case ManualControlCapability.MOVEMENT_COMMAND_TYPE.BACKWARD:
                await this.remoteHold(REMOTE_MOVE_BACKWARD, 0, 0.35);
                break;
            case ManualControlCapability.MOVEMENT_COMMAND_TYPE.ROTATE_CLOCKWISE:
                await this.remoteHold(REMOTE_MOVE_MVA_CUSTOM, REMOTE_TURN_W, 0.35);
                break;
            case ManualControlCapability.MOVEMENT_COMMAND_TYPE.ROTATE_COUNTERCLOCKWISE:
                await this.remoteHold(REMOTE_MOVE_MVA_CUSTOM, -REMOTE_TURN_W, 0.35);
                break;
            default:
                throw new Error("Invalid movementCommand.");
        }
    }

    /**
     * @private
     * @returns {string}
     */
    getSessionCode() {
        const code = this.robot.manualControlSessionCode;
        if (code === undefined || code === null || code === "") {
            throw new Error(
                "Missing robot.implementationSpecificConfig.manualControlSessionCode for Ecovacs manual control session setup."
            );
        }

        return code;
    }

    /**
     * @private
     * @param {number} moveType
     * @param {number} w
     * @param {number} durationSec
     * @returns {Promise<void>}
     */
    async remoteHold(moveType, w, durationSec) {
        const durationMs = Math.max(0, Number(durationSec) * 1000);
        const intervalMs = 200;
        const deadline = Date.now() + durationMs;
        while (Date.now() < deadline) {
            await this.robot.workManageService.remoteMove(moveType, w);
            await delay(intervalMs);
        }
        await this.robot.workManageService.remoteMove(REMOTE_MOVE_STOP);
    }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = EcovacsManualControlCapability;
