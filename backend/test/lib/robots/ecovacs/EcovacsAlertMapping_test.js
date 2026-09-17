const assert = require("node:assert");
const { describe, it } = require("node:test");

const ValetudoRobotError = require("../../../../lib/entities/core/ValetudoRobotError");
const {
    ALERT_SEVERITY,
    alertDefinition,
    alertSeverity,
    alertTypeName,
    findMostSevereErrorAlert,
    mapAlertToRobotError,
} = require("../../../../lib/robots/ecovacs/EcovacsAlertMapping");
const { ALERT_TYPE } = require("../../../../lib/robots/ecovacs/ros/core/TopicStateSubscriber");

describe("EcovacsAlertMapping", () => {
    it("has a definition for every known ALERT_TYPE", () => {
        for (const [name, type] of Object.entries(ALERT_TYPE)) {
            const definition = alertDefinition(type);

            assert.notStrictEqual(
                definition.subsystem,
                ValetudoRobotError.SUBSYSTEM.UNKNOWN,
                `ALERT_TYPE.${name} (${type}) has no explicit definition`
            );
            assert.notStrictEqual(alertTypeName(type), `Unknown alert (${type})`);
        }
    });

    it("classifies only stuck/fell/lifted/LDS/waterbox as errors", () => {
        const errorTypes = Object.values(ALERT_TYPE)
            .filter(type => alertSeverity(type) === ALERT_SEVERITY.ERROR)
            .sort((a, b) => a - b);

        assert.deepStrictEqual(errorTypes, [
            ALERT_TYPE.FALL_ERROR,
            ALERT_TYPE.DOWNIN_ERROR,
            ALERT_TYPE.ROBOT_STUCK_ERROR,
            ALERT_TYPE.LDS_ERROR,
            ALERT_TYPE.ULTRA_WATERBOX_ERROR,
        ].sort((a, b) => a - b));
    });

    it("classifies heading-unchanged as a warning, not an error", () => {
        assert.strictEqual(alertSeverity(ALERT_TYPE.DEGREE_NO_CHANGE_ERROR), ALERT_SEVERITY.WARNING);
        assert.strictEqual(
            mapAlertToRobotError(ALERT_TYPE.DEGREE_NO_CHANGE_ERROR).severity.level,
            ValetudoRobotError.SEVERITY_LEVEL.WARNING
        );
    });

    it("maps a hardware fault (LDS) to a permanent error severity", () => {
        const error = mapAlertToRobotError(ALERT_TYPE.LDS_ERROR);

        assert.strictEqual(error.severity.level, ValetudoRobotError.SEVERITY_LEVEL.ERROR);
        assert.strictEqual(error.severity.kind, ValetudoRobotError.SEVERITY_KIND.PERMANENT);
    });

    describe("findMostSevereErrorAlert", () => {
        it("ignores warning-severity alerts entirely", () => {
            const triggered = [
                { type: ALERT_TYPE.DEGREE_NO_CHANGE_ERROR, state: 1 },
                { type: ALERT_TYPE.BUMP_LONG_TIMER_TRIGE_ERROR, state: 1 },
            ];

            assert.strictEqual(findMostSevereErrorAlert(triggered), null);
        });

        it("returns null when no alerts are triggered", () => {
            assert.strictEqual(findMostSevereErrorAlert([]), null);
        });

        it("prefers ROBOT_STUCK_ERROR over ULTRA_WATERBOX_ERROR regardless of array order", () => {
            const stuckFirst = [
                { type: ALERT_TYPE.ROBOT_STUCK_ERROR, state: 1 },
                { type: ALERT_TYPE.ULTRA_WATERBOX_ERROR, state: 1 },
            ];
            const waterboxFirst = [
                { type: ALERT_TYPE.ULTRA_WATERBOX_ERROR, state: 1 },
                { type: ALERT_TYPE.ROBOT_STUCK_ERROR, state: 1 },
            ];

            assert.strictEqual(findMostSevereErrorAlert(stuckFirst).type, ALERT_TYPE.ROBOT_STUCK_ERROR);
            assert.strictEqual(findMostSevereErrorAlert(waterboxFirst).type, ALERT_TYPE.ROBOT_STUCK_ERROR);
        });

        it("falls back to the only error-severity alert present when it's not in the priority list", () => {
            const triggered = [
                { type: ALERT_TYPE.DEGREE_NO_CHANGE_ERROR, state: 1 },
                { type: ALERT_TYPE.ULTRA_WATERBOX_ERROR, state: 1 },
            ];

            assert.strictEqual(findMostSevereErrorAlert(triggered).type, ALERT_TYPE.ULTRA_WATERBOX_ERROR);
        });
    });

    describe("mapAlertToRobotError", () => {
        it("does not throw for an unknown alert type and reports UNKNOWN subsystem", () => {
            const error = mapAlertToRobotError(999);

            assert.strictEqual(error.subsystem, ValetudoRobotError.SUBSYSTEM.UNKNOWN);
            assert.strictEqual(error.vendorErrorCode, "999");
        });
    });
});
