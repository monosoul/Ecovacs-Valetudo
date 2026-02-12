const CarpetModeControlCapability = require("../../../core/capabilities/CarpetModeControlCapability");

/**
 * @extends CarpetModeControlCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsCarpetModeControlCapability extends CarpetModeControlCapability {
    async isEnabled() {
        const output = await this.robot.runSettingsCommand(["get", "suction_boost_on_carpet"]);
        const parsed = this.parseOnOff(output.stdout);

        return parsed === "on";
    }

    async enable() {
        await this.robot.runSettingsCommand(["set", "suction_boost_on_carpet", "on"]);
    }

    async disable() {
        await this.robot.runSettingsCommand(["set", "suction_boost_on_carpet", "off"]);
    }

    parseOnOff(output) {
        const normalized = String(output ?? "").trim().toLowerCase();
        const match = normalized.match(/:\s*(on|off)\s*$/m) || normalized.match(/\b(on|off)\b/);

        if (!match) {
            throw new Error(`Failed to parse carpet boost state from output: "${output}"`);
        }

        return /** @type {"on"|"off"} */ (match[1]);
    }
}

module.exports = EcovacsCarpetModeControlCapability;
