const assert = require("node:assert");
const net = require("node:net");
const { describe, it, afterEach } = require("node:test");

const { buildHandshakePacket } = require("../../../../../lib/robots/ecovacs/ros/protocol/tcpros");
const { TopicStateSubscriber } = require("../../../../../lib/robots/ecovacs/ros/core/TopicStateSubscriber");

/**
 * Fake TCPROS publisher that completes the handshake and then stays silent,
 * emulating a quiet topic (e.g. battery/alerts) that publishes no message
 * for a long time. This is the exact condition under which the subscriber
 * parks inside readExact() waiting for the next message.
 *
 * @param {Buffer} [messagePayload] - optional single message to publish after the handshake
 */
function startSilentPublisher(messagePayload) {
    /** @type {Array<net.Socket>} */
    const sockets = [];
    let handshakeSent;
    const handshakeSentPromise = new Promise(resolve => {
        handshakeSent = resolve;
    });

    const server = net.createServer(socket => {
        sockets.push(socket);
        // Ignore whatever the subscriber sends us; just reply with a valid
        // handshake and then (optionally) publish a single message.
        socket.on("data", () => {});
        socket.on("error", () => {});
        socket.write(buildHandshakePacket([
            ["md5sum", "*"],
            ["type", "test/Type"],
            ["callerid", "/fake_publisher"]
        ]));

        if (Buffer.isBuffer(messagePayload)) {
            const lengthPrefix = Buffer.alloc(4);
            lengthPrefix.writeUInt32LE(messagePayload.length, 0);
            socket.write(Buffer.concat([lengthPrefix, messagePayload]));
        }

        handshakeSent();
    });

    return new Promise(resolve => {
        server.listen(0, "127.0.0.1", () => {
            resolve({
                server: server,
                port: server.address().port,
                handshakeSentPromise: handshakeSentPromise,
                close: () => {
                    for (const socket of sockets) {
                        socket.destroy();
                    }

                    return new Promise(res => server.close(() => res()));
                }
            });
        });
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe("TopicStateSubscriber", () => {
    /** @type {{close: () => Promise<void>}|null} */
    let publisher = null;
    /** @type {TopicStateSubscriber|null} */
    let subscriber = null;

    afterEach(async () => {
        if (subscriber) {
            await subscriber.shutdown();
            subscriber = null;
        }
        if (publisher) {
            await publisher.close();
            publisher = null;
        }
    });

    it("shutdown() resolves promptly while parked reading a quiet topic", async () => {
        publisher = await startSilentPublisher();

        const masterClient = {
            resolveTopicTcpEndpoint: async () => {
                return { host: "127.0.0.1", port: publisher.port };
            },
            resolveTopicTcpEndpointSafe: async () => {
                return { host: "127.0.0.1", port: publisher.port };
            }
        };

        subscriber = new TopicStateSubscriber({
            masterClient: masterClient,
            callerId: "/test",
            topic: "/test/topic",
            type: "test/Type",
            md5: "*",
            decoder: () => null
        });

        await subscriber.start();

        // Wait until the handshake completed and the subscriber is parked in
        // readExact() waiting for the (never arriving) next message.
        await publisher.handshakeSentPromise;
        await delay(250);

        const shutdownPromise = subscriber.shutdown();
        subscriber = null; // afterEach must not shut down twice

        const timeoutHandle = { id: null };
        const timeoutPromise = new Promise((_resolve, reject) => {
            timeoutHandle.id = setTimeout(() => {
                reject(new Error("shutdown() did not resolve within 2000ms"));
            }, 2000);
        });

        try {
            await Promise.race([shutdownPromise, timeoutPromise]);
        } finally {
            clearTimeout(timeoutHandle.id);
        }

        await shutdownPromise;
        assert.ok(true, "shutdown resolved");
    });

    it("still decodes received messages and shuts down cleanly", async () => {
        const payload = Buffer.from([0x2a, 0x01]);
        publisher = await startSilentPublisher(payload);

        const masterClient = {
            resolveTopicTcpEndpoint: async () => {
                return { host: "127.0.0.1", port: publisher.port };
            },
            resolveTopicTcpEndpointSafe: async () => {
                return { host: "127.0.0.1", port: publisher.port };
            }
        };

        subscriber = new TopicStateSubscriber({
            masterClient: masterClient,
            callerId: "/test",
            topic: "/test/topic",
            type: "test/Type",
            md5: "*",
            decoder: (buf) => ({ battery: buf.readUInt8(0), flag: buf.readUInt8(1) })
        });

        await subscriber.start();

        await publisher.handshakeSentPromise;
        await delay(250);

        assert.deepStrictEqual(subscriber.getLatestValue(), { battery: 0x2a, flag: 0x01 });

        const shutdownPromise = subscriber.shutdown();
        subscriber = null; // afterEach must not shut down twice

        const timeoutHandle = { id: null };
        const timeoutPromise = new Promise((_resolve, reject) => {
            timeoutHandle.id = setTimeout(() => {
                reject(new Error("shutdown() did not resolve within 2000ms"));
            }, 2000);
        });

        try {
            await Promise.race([shutdownPromise, timeoutPromise]);
        } finally {
            clearTimeout(timeoutHandle.id);
        }

        await shutdownPromise;
        assert.ok(true, "shutdown resolved");
    });
});
