const TotalStatisticsCapability = require("../../../core/capabilities/TotalStatisticsCapability");
const ValetudoDataPoint = require("../../../entities/core/ValetudoDataPoint");

/**
 * @extends TotalStatisticsCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsTotalStatisticsCapability extends TotalStatisticsCapability {
    /**
     * @return {Promise<Array<ValetudoDataPoint>>}
     */
    async getStatistics() {
        const stats = await this.robot.rosFacade.getTotalStatistics();

        return [
            new ValetudoDataPoint({
                type: ValetudoDataPoint.TYPES.COUNT,
                value: stats.totalCnt
            }),
            new ValetudoDataPoint({
                type: ValetudoDataPoint.TYPES.TIME,
                value: stats.totalSecs
            }),
            new ValetudoDataPoint({
                type: ValetudoDataPoint.TYPES.AREA,
                value: stats.totalAreaM2 * 10000 // m² to cm²
            })
        ];
    }

    getProperties() {
        return {
            availableStatistics: [
                ValetudoDataPoint.TYPES.COUNT,
                ValetudoDataPoint.TYPES.TIME,
                ValetudoDataPoint.TYPES.AREA
            ]
        };
    }
}

module.exports = EcovacsTotalStatisticsCapability;
