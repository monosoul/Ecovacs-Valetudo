const assert = require("node:assert");
const { describe, it } = require("node:test");

const EcovacsAlertStatusResolver = require("../../../../lib/robots/ecovacs/EcovacsAlertStatusResolver");
const entities = require("../../../../lib/entities");
const { ALERT_TYPE } = require("../../../../lib/robots/ecovacs/ros/core/TopicStateSubscriber");
const { WORK_STATE, WORK_TYPE } = require("../../../../lib/robots/ecovacs/EcovacsStateMapping");

const stateAttrs = entities.state.attributes;

function alert(type) {
    return { type: type, state: 1 };
}

const NOT_ON_CHARGER = { isOnCharger: 0, chargeState: 0 };
const ON_CHARGER = { isOnCharger: 1, chargeState: 2 };

const RUNNING_AUTO_CLEAN = { worktype: WORK_TYPE.AUTO_CLEAN, state: WORK_STATE.RUNNING, workcause: 0 };
const PAUSED_AUTO_CLEAN = { worktype: WORK_TYPE.AUTO_CLEAN, state: WORK_STATE.PAUSED, workcause: 0 };
const IDLE_WORK_STATE = { worktype: WORK_TYPE.IDLE, state: WORK_STATE.IDLE, workcause: 0 };

describe("EcovacsAlertStatusResolver", () => {
    describe("status decision table", () => {
        it("reports docked when on the charger, regardless of alerts or workState", () => {
            const resolver = new EcovacsAlertStatusResolver();

            const result = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.ROBOT_STUCK_ERROR)],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: ON_CHARGER
            });

            assert.strictEqual(result.statusValue, stateAttrs.StatusStateAttribute.VALUE.DOCKED);
            assert.strictEqual(result.error, null);
        });

        it("keeps status cleaning and drops the alert override while the robot is running", () => {
            const resolver = new EcovacsAlertStatusResolver();

            const result = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.ROBOT_STUCK_ERROR)],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });

            assert.strictEqual(result.statusValue, stateAttrs.StatusStateAttribute.VALUE.CLEANING);
            assert.strictEqual(result.statusFlag, stateAttrs.StatusStateAttribute.FLAG.NONE);
            assert.strictEqual(result.error, null);
        });

        it("never escalates a warning-severity alert (heading unchanged) while running", () => {
            const resolver = new EcovacsAlertStatusResolver();

            const result = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.DEGREE_NO_CHANGE_ERROR)],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });

            assert.strictEqual(result.statusValue, stateAttrs.StatusStateAttribute.VALUE.CLEANING);
            assert.strictEqual(result.error, null);
            assert.deepStrictEqual(result.eventMessages, []);
        });

        it("escalates to error+resumable when paused with an active error alert", () => {
            const resolver = new EcovacsAlertStatusResolver();

            const result = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.ROBOT_STUCK_ERROR)],
                workState: PAUSED_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });

            assert.strictEqual(result.statusValue, stateAttrs.StatusStateAttribute.VALUE.ERROR);
            assert.strictEqual(result.statusFlag, stateAttrs.StatusStateAttribute.FLAG.RESUMABLE);
            assert.strictEqual(result.error.message, "Robot stuck");
            assert.deepStrictEqual(result.eventMessages, [], "upstream already raises the dismissible event on entering ERROR");
        });

        it("reports paused+resumable (no error) when paused without an alert", () => {
            const resolver = new EcovacsAlertStatusResolver();

            const result = resolver.resolve({
                triggeredAlerts: [],
                workState: PAUSED_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });

            assert.strictEqual(result.statusValue, stateAttrs.StatusStateAttribute.VALUE.PAUSED);
            assert.strictEqual(result.statusFlag, stateAttrs.StatusStateAttribute.FLAG.RESUMABLE);
            assert.strictEqual(result.error, null);
        });

        it("escalates to error when idle with an active error alert", () => {
            const resolver = new EcovacsAlertStatusResolver();

            const result = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.FALL_ERROR)],
                workState: IDLE_WORK_STATE,
                chargeState: NOT_ON_CHARGER
            });

            assert.strictEqual(result.statusValue, stateAttrs.StatusStateAttribute.VALUE.ERROR);
            assert.strictEqual(result.statusFlag, stateAttrs.StatusStateAttribute.FLAG.NONE);
            assert.strictEqual(result.error.message, "Cliff sensor error");
        });

        it("reports idle (no error) with no workState and no alerts", () => {
            const resolver = new EcovacsAlertStatusResolver();

            const result = resolver.resolve({
                triggeredAlerts: [],
                workState: null,
                chargeState: NOT_ON_CHARGER
            });

            assert.strictEqual(result.statusValue, stateAttrs.StatusStateAttribute.VALUE.IDLE);
            assert.strictEqual(result.error, null);
        });
    });

    describe("event notification while running", () => {
        it("raises exactly one dismissible event when an error alert first appears while running", () => {
            const resolver = new EcovacsAlertStatusResolver();

            const first = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.ROBOT_STUCK_ERROR)],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });
            assert.strictEqual(first.eventMessages.length, 1);
            assert.match(first.eventMessages[0], /Robot stuck/);

            const second = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.ROBOT_STUCK_ERROR)],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });
            assert.deepStrictEqual(second.eventMessages, [], "must not re-raise on an unchanged poll");
        });
    });

    describe("alert edge logging", () => {
        it("logs a raise once, nothing on repeats, and a clear once", () => {
            const resolver = new EcovacsAlertStatusResolver();

            const raised = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.DEGREE_NO_CHANGE_ERROR)],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });
            assert.strictEqual(raised.logEntries.length, 1);
            assert.strictEqual(raised.logEntries[0].level, "warn");
            assert.match(raised.logEntries[0].message, /Ecovacs alert raised: Heading unchanged \(type=21, severity=warning\)/);

            const repeated = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.DEGREE_NO_CHANGE_ERROR)],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });
            assert.deepStrictEqual(repeated.logEntries, []);

            const cleared = resolver.resolve({
                triggeredAlerts: [],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });
            assert.strictEqual(cleared.logEntries.length, 1);
            assert.strictEqual(cleared.logEntries[0].level, "info");
            assert.match(cleared.logEntries[0].message, /Ecovacs alert cleared: Heading unchanged \(type=21\)/);

            const stillCleared = resolver.resolve({
                triggeredAlerts: [],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });
            assert.deepStrictEqual(stillCleared.logEntries, []);
        });

        it("does not treat a null observation (topic not yet received) as everything clearing", () => {
            const resolver = new EcovacsAlertStatusResolver();

            resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.DEGREE_NO_CHANGE_ERROR)],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });

            const nullObservation = resolver.resolve({
                triggeredAlerts: null,
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });
            assert.deepStrictEqual(nullObservation.logEntries, [], "no observation must not be logged as a clear");

            // The alert must still be considered "already seen" - re-observing the exact
            // same alert after the null tick must not re-raise it.
            const sameAlertAgain = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.DEGREE_NO_CHANGE_ERROR)],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });
            assert.deepStrictEqual(sameAlertAgain.logEntries, []);
        });

        it("logs INFO-severity alerts at debug level", () => {
            const resolver = new EcovacsAlertStatusResolver();

            const result = resolver.resolve({
                triggeredAlerts: [alert(ALERT_TYPE.DIRT_BOX_STATE)],
                workState: RUNNING_AUTO_CLEAN,
                chargeState: NOT_ON_CHARGER
            });

            assert.strictEqual(result.logEntries.length, 1);
            assert.strictEqual(result.logEntries[0].level, "debug");
        });
    });
});
