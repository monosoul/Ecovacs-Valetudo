const BasicControlCapability = require("../../../core/capabilities/BasicControlCapability");
const entities = require("../../../entities");

const stateAttrs = entities.state.attributes;

/**
 * @extends BasicControlCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsBasicControlCapability extends BasicControlCapability {
    async start() {
        await this.robot.runStartCleanCommand(["start"]);
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.CLEANING);
    }

    async stop() {
        await this.robot.runStartCleanCommand(["stop"]);
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.IDLE);
    }

    async pause() {
        await this.robot.runStartCleanCommand(["pause"]);
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.PAUSED);
    }

    async home() {
        await this.robot.runStartCleanCommand(["home"]);
        this.robot.setStatus(stateAttrs.StatusStateAttribute.VALUE.RETURNING);
    }
}

module.exports = EcovacsBasicControlCapability;
