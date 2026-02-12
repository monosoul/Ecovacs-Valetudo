const LocateCapability = require("../../../core/capabilities/LocateCapability");

/**
 * @extends LocateCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsLocateCapability extends LocateCapability {
    async locate() {
        await this.robot.runSoundCommand(["locate"]);
    }
}

module.exports = EcovacsLocateCapability;
