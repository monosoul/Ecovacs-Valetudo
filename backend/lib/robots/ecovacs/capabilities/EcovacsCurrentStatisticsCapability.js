const CurrentStatisticsCapability = require("../../../core/capabilities/CurrentStatisticsCapability");
const ValetudoDataPoint = require("../../../entities/core/ValetudoDataPoint");

/**
 * Reports current/last cleaning session statistics.
 *
 * Primary source: /worklog/WorkStatisticToWifi topic (live updates during cleaning).
 * Fallback: /worklog/GetLastLogInfo service call (on-demand, e.g. on startup before
 * the topic has published).
 *
 * @extends CurrentStatisticsCapability<import("../EcovacsT8AiviValetudoRobot")>
 */
class EcovacsCurrentStatisticsCapability extends CurrentStatisticsCapability {
    /**
     * @return {Promise<Array<ValetudoDataPoint>>}
     */
    async getStatistics() {
        // Try the topic subscriber cache first (no RPC round-trip)
        let stats = this.robot.statisticsService.getWorkStatistic(Infinity);

        // Fall back to the service call if the topic hasn't published yet
        if (stats === null) {
            stats = await this.robot.statisticsService.getLastCleanStatistics();
        }

        return [
            new ValetudoDataPoint({
                type: ValetudoDataPoint.TYPES.TIME,
                value: stats.worktime
            }),
            new ValetudoDataPoint({
                type: ValetudoDataPoint.TYPES.AREA,
                value: stats.workareaM2 * 10000 // m² to cm²
            })
        ];
    }

    getProperties() {
        return {
            availableStatistics: [
                ValetudoDataPoint.TYPES.TIME,
                ValetudoDataPoint.TYPES.AREA
            ]
        };
    }
}

module.exports = EcovacsCurrentStatisticsCapability;
