const entities = require("../../../entities");
const ManualControlCapability = require("../../../core/capabilities/ManualControlCapability");

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

        const sessionCode = this.robot.getManualControlSessionCode();
        await this.robot.runStartCleanCommand(["remote-session-open", String(sessionCode)]);

        this.robot.manualControlActiveFlag = true;
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.MANUAL_CONTROL);
    }

    async disableManualControl() {
        if (this.robot.manualControlActiveFlag === false) {
            return;
        }

        try {
            await this.robot.runStartCleanCommand(["remote-stop"]);
        } catch (e) {
            // Stopping manual control session is more important than stop best-effort
        }

        await this.robot.runStartCleanCommand(["remote-session-close"]);

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

        let command;
        switch (movementCommand) {
            case ManualControlCapability.MOVEMENT_COMMAND_TYPE.FORWARD:
                command = "remote-forward";
                break;
            case ManualControlCapability.MOVEMENT_COMMAND_TYPE.BACKWARD:
                command = "remote-backward";
                break;
            case ManualControlCapability.MOVEMENT_COMMAND_TYPE.ROTATE_CLOCKWISE:
                command = "remote-turn-right";
                break;
            case ManualControlCapability.MOVEMENT_COMMAND_TYPE.ROTATE_COUNTERCLOCKWISE:
                command = "remote-turn-left";
                break;
            default:
                throw new Error("Invalid movementCommand.");
        }

        await this.robot.runStartCleanCommand([command]);
    }
}

module.exports = EcovacsManualControlCapability;
